//! Сигналинг Звонилки через публичные MQTT-брокеры — тот же, что в web/call.js.
//!
//! Из кода комнаты HKDF-SHA256 (соль «zvonilka», info «zvonilka signal v1») даёт 48 байт:
//! тему `zvonilka/<32 hex>` и ключ AES-256-GCM. Каждое сообщение — JSON, запечатанный как
//! IV (12) ‖ шифртекст ‖ метка (16), тема — связанные данные: брокер видит случайную тему
//! и шум. Узел держит с каждым брокером из `brokers` соединение MQTT 3.1.1 поверх
//! WebSocket и TLS — как страница; `Transport.tcp` — запасной путь без TLS, порт 1883
//! (сообщения запечатаны и там).
//!
//! Потоки: у каждого брокера свой поток чтения, он же зовёт обработчик сообщений.
//! `send` пишет в сокеты и может ждать — звать её из потока, который пересылает медиа, нельзя.
const std = @import("std");
const Io = std.Io;
const net = std.Io.net;
const tls = std.crypto.tls;
const mqtt = @import("mqtt.zig");
const ws = @import("ws.zig");
const HkdfSha256 = std.crypto.kdf.hkdf.HkdfSha256;
const Aes256Gcm = std.crypto.aead.aes_gcm.Aes256Gcm;

pub const Broker = struct { host: []const u8, wss_port: u16, tcp_port: u16, path: []const u8 };

/// Те же брокеры, что BROKERS в web/call.js.
pub const brokers = [_]Broker{
    .{ .host = "broker.emqx.io", .wss_port = 8084, .tcp_port = 1883, .path = "/mqtt" },
    .{ .host = "broker.hivemq.com", .wss_port = 8884, .tcp_port = 1883, .path = "/mqtt" },
};

pub const Transport = enum { wss, tcp };

/// Offer Chrome с четырьмя медиа-каналами — около 13 КБ; с запасом.
pub const max_message = 64 * 1024;
const keepalive_s = 60;
const ping_every_us: u64 = 25_000_000;
const dead_after_us: u64 = 80_000_000;
const connack_timeout_us: u64 = 20_000_000;

// ---------------------------------------------------------------------------
// Ключи комнаты и печать сообщений.

pub const topic_len = "zvonilka/".len + 32;

pub const Keys = struct {
    topic_buf: [topic_len]u8,
    key: [32]u8,

    pub fn topic(k: *const Keys) []const u8 {
        return &k.topic_buf;
    }
};

pub fn derive(room: []const u8) Keys {
    const prk = HkdfSha256.extract("zvonilka", room);
    var okm: [48]u8 = undefined;
    HkdfSha256.expand(&okm, "zvonilka signal v1", prk);
    var k: Keys = .{ .topic_buf = undefined, .key = okm[16..48].* };
    @memcpy(k.topic_buf[0.."zvonilka/".len], "zvonilka/");
    const hex = std.fmt.bytesToHex(okm[0..16], .lower);
    @memcpy(k.topic_buf["zvonilka/".len..], &hex);
    std.crypto.secureZero(u8, &okm);
    return k;
}

pub fn sealedLen(plain_len: usize) usize {
    return 12 + plain_len + 16;
}

pub fn seal(out: []u8, k: *const Keys, nonce: [12]u8, plain: []const u8) []u8 {
    @memcpy(out[0..12], &nonce);
    var tag: [16]u8 = undefined;
    Aes256Gcm.encrypt(out[12..][0..plain.len], &tag, plain, k.topic(), nonce, k.key);
    @memcpy(out[12 + plain.len ..][0..16], &tag);
    return out[0 .. 12 + plain.len + 16];
}

/// Открытый текст или null, если сообщение не наше: другой ключ, испорчено, подделано.
pub fn open(out: []u8, k: *const Keys, msg: []const u8) ?[]u8 {
    if (msg.len < 28 or msg.len - 28 > out.len) return null;
    const plain = out[0 .. msg.len - 28];
    Aes256Gcm.decrypt(plain, msg[12 .. msg.len - 16], msg[msg.len - 16 ..][0..16].*, k.topic(), msg[0..12].*, k.key) catch return null;
    return plain;
}

// ---------------------------------------------------------------------------
// Повторы. У каждого отправителя свой счётчик сообщений: вторая копия через другой брокер
// и сообщение, записанное и присланное снова, приходят с уже виденным номером.

pub const Seen = struct {
    top: u64 = 0,
    /// Бит i: номер top − i уже был.
    bits: [4]u64 = @splat(0),

    const span = 256;

    /// true — номер новый, и он запомнен.
    pub fn fresh(s: *Seen, n: u64) bool {
        if (n == 0) return false;
        if (n > s.top) {
            const ahead = n - s.top;
            s.shift(ahead);
            s.top = n;
            s.bits[0] |= 1;
            return true;
        }
        const back = s.top - n;
        if (back >= span) return false;
        const word = back / 64;
        const bit = @as(u64, 1) << @intCast(back % 64);
        if (s.bits[word] & bit != 0) return false;
        s.bits[word] |= bit;
        return true;
    }

    fn shift(s: *Seen, by: u64) void {
        if (by >= span) {
            s.bits = @splat(0);
            return;
        }
        const words: usize = @intCast(by / 64);
        const rest: u6 = @intCast(by % 64);
        var i: usize = s.bits.len;
        while (i > 0) {
            i -= 1;
            var v: u64 = 0;
            if (i >= words) {
                v = s.bits[i - words] << rest;
                if (rest != 0 and i > words) v |= s.bits[i - words - 1] >> @intCast(64 - @as(u7, rest));
            }
            s.bits[i] = v;
        }
    }
};

// ---------------------------------------------------------------------------
// Соединения с брокерами.

pub const Handler = *const fn (ctx: *anyopaque, plaintext: []const u8) void;
pub const LogFn = *const fn (ctx: *anyopaque, msg: []const u8) void;

/// Одно установленное соединение: поток TCP, поверх него TLS и WebSocket — или ничего.
/// Читает только поток брокера; пишут под `Conn.write_mutex`.
const Link = struct {
    io: Io,
    sr: net.Stream.Reader,
    sw: net.Stream.Writer,
    tls_client: ?tls.Client = null,
    frames: Deframer,

    fn reader(l: *Link) *Io.Reader {
        return if (l.tls_client) |*t| &t.reader else &l.sr.interface;
    }

    fn writer(l: *Link) *Io.Writer {
        return if (l.tls_client) |*t| &t.writer else &l.sw.interface;
    }

    fn flush(l: *Link) !void {
        if (l.tls_client) |*t| try t.writer.flush();
        try l.sw.interface.flush();
    }

    /// Пакет MQTT целиком: в WebSocket — одним двоичным кадром с маской.
    fn sendPacket(l: *Link, packet: []const u8) !void {
        const w = l.writer();
        if (l.frames.websocket) {
            try l.writeFrame(.binary, packet);
        } else try w.writeAll(packet);
        try l.flush();
    }

    fn writeFrame(l: *Link, opcode: ws.Opcode, payload: []const u8) !void {
        const w = l.writer();
        var mask: [4]u8 = undefined;
        l.io.random(&mask);
        var hb: [14]u8 = undefined;
        try w.writeAll(ws.clientHeader(&hb, opcode, payload.len, mask));
        var chunk: [1024]u8 = undefined;
        var off: usize = 0;
        while (off < payload.len) {
            const n = @min(chunk.len, payload.len - off);
            for (chunk[0..n], payload[off..][0..n], off..) |*d, s, i| d.* = s ^ mask[i & 3];
            try w.writeAll(chunk[0..n]);
            off += n;
        }
    }

    fn readSome(l: *Link, dst: []u8, control: *?Deframer.Control) !usize {
        return l.frames.readSome(l.reader(), dst, control);
    }
};

/// Достаёт поток MQTT из того, что прислал брокер: из TCP — как есть, из WebSocket —
/// содержимое кадров с данными, сколько бы пакетов MQTT в кадре ни было и как бы они ни
/// были разрезаны.
const Deframer = struct {
    websocket: bool,
    /// Сколько байт текущего кадра ещё не прочитано и несёт ли он данные.
    frame_left: u64 = 0,
    frame_data: bool = false,

    /// Пинг WebSocket: на него отвечают понгом с тем же содержимым.
    const Control = struct { len: usize, data: [125]u8 = undefined };

    /// Следующая порция потока MQTT, не меньше байта. Пришёл пинг — возвращает 0 и кладёт его
    /// в `control`; кадр закрытия — ошибка.
    fn readSome(d: *Deframer, r: *Io.Reader, dst: []u8, control: *?Control) !usize {
        while (true) {
            if (d.websocket and d.frame_left == 0) {
                const h = while (true) {
                    if (ws.parseServerHeader(r.buffered()) catch return error.BadFrame) |h| break h;
                    try r.fillMore();
                };
                r.toss(h.used);
                switch (h.opcode) {
                    .binary, .continuation, .text => {
                        d.frame_data = true;
                        d.frame_left = h.len;
                    },
                    .close => return error.ConnectionClosed,
                    .ping => {
                        // Управляющий кадр не длиннее 125 байт: читаем целиком и отдаём наверх.
                        if (h.len > 125) return error.BadFrame;
                        var c: Control = .{ .len = @intCast(h.len) };
                        while (r.bufferedLen() < c.len) try r.fillMore();
                        @memcpy(c.data[0..c.len], r.buffered()[0..c.len]);
                        r.toss(c.len);
                        control.* = c;
                        return 0;
                    },
                    else => {
                        d.frame_data = false;
                        d.frame_left = h.len;
                    },
                }
                continue;
            }
            if (r.bufferedLen() == 0) try r.fillMore();
            const b = r.buffered();
            var n = @min(b.len, dst.len);
            if (d.websocket) {
                n = @intCast(@min(@as(u64, n), d.frame_left));
                d.frame_left -= n;
                if (!d.frame_data) {
                    r.toss(n);
                    continue;
                }
            }
            @memcpy(dst[0..n], b[0..n]);
            r.toss(n);
            if (n > 0) return n;
        }
    }
};

/// Собирает пакеты MQTT из потока байтов. В публичную тему может написать кто угодно: пакет
/// больше, чем узел берёт, пропускается, а соединение остаётся.
const Assembler = struct {
    buf: []u8,
    len: usize = 0,
    /// Сколько байт слишком большого пакета ещё пропустить.
    skip: usize = 0,
    /// Сколько байт занимает пакет, отданный в прошлый раз: он уйдёт из буфера при следующем вызове.
    taken: usize = 0,
    limit: usize,

    /// Куда читать следующую порцию потока; пусто — в буфер не помещается даже заголовок.
    fn space(a: *Assembler) []u8 {
        a.release();
        return a.buf[a.len..];
    }

    /// В `space()` прочитано `n` байт.
    fn advance(a: *Assembler, n: usize) void {
        const drop = @min(a.skip, n);
        a.skip -= drop;
        if (drop > 0) std.mem.copyForwards(u8, a.buf[a.len .. a.len + n - drop], a.buf[a.len + drop .. a.len + n]);
        a.len += n - drop;
    }

    /// Следующий целый пакет или null, если данных пока мало. Пакет указывает в буфер и живёт
    /// до следующего вызова `next` или `space`.
    fn next(a: *Assembler) error{Malformed}!?mqtt.Packet {
        a.release();
        while (true) {
            const p = mqtt.parse(a.buf[0..a.len], a.limit) catch {
                const total = mqtt.packetLen(a.buf[0..a.len]) orelse return error.Malformed;
                if (total <= a.len) {
                    std.mem.copyForwards(u8, a.buf[0 .. a.len - total], a.buf[total..a.len]);
                    a.len -= total;
                } else {
                    a.skip = total - a.len;
                    a.len = 0;
                }
                continue;
            };
            if (p) |packet| a.taken = packet.used;
            return p;
        }
    }

    fn release(a: *Assembler) void {
        if (a.taken == 0) return;
        std.mem.copyForwards(u8, a.buf[0 .. a.len - a.taken], a.buf[a.taken..a.len]);
        a.len -= a.taken;
        a.taken = 0;
    }
};

/// Один брокер. `Signal.mutex` бережёт то, на что смотрят keepalive и `connected`;
/// `write_mutex` — запись. Кто держит `Signal.mutex`, никогда не ждёт `write_mutex`.
const Conn = struct {
    /// От подключения до закрытия сокета: через него keepalive рвёт зависшее соединение.
    sock: ?net.Stream = null,
    connected_at_us: u64 = 0,
    connacked: bool = false,
    last_ping_us: u64 = 0,
    last_rx_us: std.atomic.Value(u64) = .init(0),

    write_mutex: Io.Mutex = .init,
    /// Куда пишут: от CONNACK до закрытия, под `write_mutex`.
    link: ?*Link = null,
};

const Verdict = enum { wait, ping, close };

/// Что keepalive делает с соединением в момент `t`: рвёт то, что не дождалось CONNACK или
/// замолчало, пингует то, что давно простаивает.
fn verdict(c: *const Conn, t: u64) Verdict {
    if (!c.connacked) return if (t -| c.connected_at_us > connack_timeout_us) .close else .wait;
    if (t -| c.last_rx_us.load(.monotonic) > dead_after_us) return .close;
    return if (t -| c.last_ping_us >= ping_every_us) .ping else .wait;
}

pub const Signal = struct {
    gpa: std.mem.Allocator,
    io: Io,
    transport: Transport,
    mutex: Io.Mutex = .init,
    keys: Keys,
    conns: [brokers.len]Conn = @splat(.{}),
    handler: Handler,
    /// Позвать, когда брокер начал слушать тему: пора сказать о себе.
    ready: *const fn (ctx: *anyopaque) void,
    ctx: *anyopaque,
    log_fn: LogFn,
    ca_bundle: std.crypto.Certificate.Bundle = .empty,
    ca_lock: Io.RwLock = .init,

    pub const Options = struct {
        transport: Transport = .wss,
        handler: Handler,
        ready: *const fn (ctx: *anyopaque) void,
        ctx: *anyopaque,
        log_fn: LogFn,
    };

    /// Готовит сигналинг; соединения с брокерами начинает `start`.
    pub fn create(gpa: std.mem.Allocator, io: Io, keys: Keys, o: Options) !*Signal {
        const s = try gpa.create(Signal);
        errdefer gpa.destroy(s);
        s.* = .{ .gpa = gpa, .io = io, .transport = o.transport, .keys = keys, .handler = o.handler, .ready = o.ready, .ctx = o.ctx, .log_fn = o.log_fn };
        if (s.transport == .wss) {
            // Корневые сертификаты системы: по ним проверяются сертификаты брокеров.
            s.ca_bundle.rescan(gpa, io, Io.Clock.real.now(io)) catch |e| {
                s.log("сигналинг: корневые сертификаты не прочитаны ({t}); без TLS — ключ --tcp", .{e});
                return error.NoRootCertificates;
            };
        }
        return s;
    }

    /// Запускает потоки брокеров. С этого момента зовутся `handler` и `ready`: тот, кому
    /// они нужны, уже должен держать указатель на сигналинг.
    pub fn start(s: *Signal) !void {
        for (0..brokers.len) |i| {
            const t = try std.Thread.spawn(.{ .stack_size = 1024 * 1024 }, brokerMain, .{ s, i });
            t.detach();
        }
    }

    fn log(s: *Signal, comptime fmt: []const u8, args: anytype) void {
        var buf: [320]u8 = undefined;
        s.log_fn(s.ctx, std.fmt.bufPrint(&buf, fmt, args) catch return);
    }

    fn now(s: *Signal) u64 {
        return @intCast(@divTrunc(Io.Clock.awake.now(s.io).nanoseconds, 1000));
    }

    /// На скольких брокерах тема сейчас слушается.
    pub fn connected(s: *Signal) usize {
        s.mutex.lockUncancelable(s.io);
        defer s.mutex.unlock(s.io);
        var n: usize = 0;
        for (&s.conns) |*c| {
            if (c.sock != null and c.connacked) n += 1;
        }
        return n;
    }

    /// Запечатывает сообщение и публикует на всех подключённых брокерах. Пока идёт запись,
    /// держится только замок этого соединения.
    pub fn send(s: *Signal, plaintext: []const u8) void {
        if (plaintext.len > max_message) return;
        var nonce: [12]u8 = undefined;
        s.io.random(&nonce);
        const sealed = s.gpa.alloc(u8, sealedLen(plaintext.len)) catch return;
        defer s.gpa.free(sealed);
        _ = seal(sealed, &s.keys, nonce, plaintext);
        const packet = s.gpa.alloc(u8, mqtt.publishSize(s.keys.topic(), sealed.len)) catch return;
        defer s.gpa.free(packet);
        const p = mqtt.publish(packet, s.keys.topic(), sealed);
        for (&s.conns) |*c| {
            c.write_mutex.lockUncancelable(s.io);
            defer c.write_mutex.unlock(s.io);
            if (c.link) |l| l.sendPacket(p) catch {};
        }
    }

    /// Раз в секунду: пингует брокеров и рвёт соединения, которые не дождались CONNACK или
    /// замолчали. Никогда не ждёт пишущего.
    pub fn keepalive(s: *Signal) void {
        const t = s.now();
        var ping: [brokers.len]bool = @splat(false);
        s.mutex.lockUncancelable(s.io);
        for (&s.conns, &ping) |*c, *due| {
            const sock = c.sock orelse continue;
            switch (verdict(c, t)) {
                .wait => {},
                .close => sock.shutdown(s.io, .both) catch {}, // будит поток чтения, он подключится заново
                .ping => {
                    c.last_ping_us = t;
                    due.* = true;
                },
            }
        }
        s.mutex.unlock(s.io);
        // Только пока соединение никто не занял: пишущий, застрявший на брокере, который
        // перестал читать, держит замок, и с таким брокером разберётся таймер тишины.
        for (&s.conns, ping) |*c, due| {
            if (!due or !c.write_mutex.tryLock()) continue;
            defer c.write_mutex.unlock(s.io);
            if (c.link) |l| l.sendPacket(&mqtt.pingreq) catch {};
        }
    }

    fn brokerMain(s: *Signal, i: usize) void {
        var backoff_ms: u64 = 1_000;
        while (true) {
            const started = s.now();
            s.connection(i) catch |e| s.log("сигналинг: {s}: {t}", .{ brokers[i].host, e });
            if (s.now() -| started > 120_000_000) backoff_ms = 1_000;
            s.io.sleep(.fromMilliseconds(@intCast(backoff_ms)), .awake) catch {};
            backoff_ms = @min(backoff_ms * 2, 60_000);
        }
    }

    fn connection(s: *Signal, i: usize) !void {
        const io = s.io;
        const gpa = s.gpa;
        const b = brokers[i];
        const secure = s.transport == .wss;
        const port = if (secure) b.wss_port else b.tcp_port;
        const host_name = try net.HostName.init(b.host);
        // Без таймаута: Io.Threaded в Zig 0.17.1 на нём паникует.
        const stream = try host_name.connect(io, port, .{ .mode = .stream });
        const c = &s.conns[i];
        // С этого места keepalive может оборвать сокет: брокер, который молчит, будет брошен.
        s.mutex.lockUncancelable(io);
        c.sock = stream;
        c.connected_at_us = s.now();
        s.mutex.unlock(io);
        defer {
            s.mutex.lockUncancelable(io);
            c.sock = null;
            c.connacked = false;
            s.mutex.unlock(io);
            stream.shutdown(io, .both) catch {}; // пишущий, застрявший на этом сокете, сдаётся
            c.write_mutex.lockUncancelable(io);
            c.link = null;
            c.write_mutex.unlock(io);
            stream.close(io);
        }

        // Буферы: шифртекст TLS в обе стороны и расшифрованное; без TLS хватило бы меньшего.
        const record = tls.Client.min_buffer_len;
        const bufs = try gpa.alloc(u8, record * 4 + 4096);
        defer gpa.free(bufs);
        const link = try gpa.create(Link);
        defer gpa.destroy(link);
        link.* = .{
            .io = io,
            .sr = stream.reader(io, bufs[0..record]),
            .sw = stream.writer(io, bufs[record..][0..record]),
            .frames = .{ .websocket = secure },
        };
        if (secure) {
            var entropy: [tls.Client.Options.entropy_len]u8 = undefined;
            io.random(&entropy);
            link.tls_client = tls.Client.init(&link.sr.interface, &link.sw.interface, .{
                .host = .{ .explicit = b.host },
                .ca = .{ .bundle = .{ .gpa = gpa, .io = io, .lock = &s.ca_lock, .bundle = &s.ca_bundle } },
                .read_buffer = bufs[record * 2 ..][0 .. record * 2],
                .write_buffer = bufs[record * 4 ..],
                .entropy = &entropy,
                .realtime_now = Io.Clock.real.now(io),
            }) catch |e| switch (e) {
                error.ReadFailed, error.WriteFailed => return error.ConnectionClosed,
                else => return e,
            };
            try s.upgrade(link, b, port);
        }

        var id_bytes: [6]u8 = undefined;
        io.random(&id_bytes);
        var cid_buf: [16]u8 = undefined;
        const cid = std.fmt.bufPrint(&cid_buf, "zv-{x}", .{&id_bytes}) catch unreachable;
        var out: [64]u8 = undefined;
        // До CONNACK пишет только этот поток: остальные не видят `c.link`.
        try link.sendPacket(mqtt.connect(&out, cid, keepalive_s));

        const buf = try gpa.alloc(u8, max_message + 1024);
        defer gpa.free(buf);
        var packets: Assembler = .{ .buf = buf, .limit = max_message + 512 };
        const plain = try gpa.alloc(u8, max_message);
        defer gpa.free(plain);

        var connacked = false;
        while (true) {
            while (try packets.next()) |p| {
                c.last_rx_us.store(s.now(), .monotonic);
                switch (p.kind) {
                    mqtt.connack_type => if (!connacked) {
                        if (p.body.len < 2 or p.body[1] != 0) return error.Refused;
                        connacked = true;
                        s.subscribe(c, link);
                        s.log("сигналинг: слушаю {s}", .{b.host});
                        s.ready(s.ctx);
                    },
                    mqtt.publish_type => if (mqtt.parsePublish(p)) |msg| {
                        if (std.mem.eql(u8, msg.topic, s.keys.topic())) {
                            if (open(plain, &s.keys, msg.payload)) |text| s.handler(s.ctx, text);
                        }
                    },
                    else => {},
                }
            }
            const room = packets.space();
            if (room.len == 0) return error.Malformed;
            var control: ?Deframer.Control = null;
            const n = link.readSome(room, &control) catch |e| switch (e) {
                error.ReadFailed, error.EndOfStream => return if (connacked) error.ConnectionClosed else error.NoConnack,
                else => return e,
            };
            if (control) |ping| {
                // Пинг WebSocket: тем же содержимым отвечаем понгом.
                c.write_mutex.lockUncancelable(io);
                defer c.write_mutex.unlock(io);
                link.writeFrame(.pong, ping.data[0..ping.len]) catch {};
                link.flush() catch {};
                continue;
            }
            packets.advance(n);
        }
    }

    /// Рукопожатие WebSocket: запрос с подпротоколом mqtt, в ответ — 101 и верный Sec-WebSocket-Accept.
    fn upgrade(s: *Signal, link: *Link, b: Broker, port: u16) !void {
        var key_raw: [16]u8 = undefined;
        s.io.random(&key_raw);
        var key_buf: [24]u8 = undefined;
        const key = std.base64.standard.Encoder.encode(&key_buf, &key_raw);
        const w = link.writer();
        w.print("GET {s} HTTP/1.1\r\nHost: {s}:{d}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" ++
            "Sec-WebSocket-Key: {s}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n", .{ b.path, b.host, port, key }) catch return error.ConnectionClosed;
        link.flush() catch return error.ConnectionClosed;
        const r = link.reader();
        const head_len = while (true) {
            if (std.mem.find(u8, r.buffered(), "\r\n\r\n")) |at| break at + 4;
            if (r.bufferedLen() >= 8192) return error.BadHandshake;
            r.fillMore() catch return error.ConnectionClosed;
        };
        const head = r.buffered()[0..head_len];
        if (!std.mem.startsWith(u8, head, "HTTP/1.1 101")) return error.BadHandshake;
        var accept_buf: [28]u8 = undefined;
        const want = ws.acceptKey(key, &accept_buf);
        var ok = false;
        var lines = std.mem.splitSequence(u8, head, "\r\n");
        while (lines.next()) |line| {
            const colon = std.mem.findScalar(u8, line, ':') orelse continue;
            if (!std.ascii.eqlIgnoreCase(std.mem.trim(u8, line[0..colon], " \t"), "sec-websocket-accept")) continue;
            ok = std.mem.eql(u8, std.mem.trim(u8, line[colon + 1 ..], " \t"), want);
        }
        if (!ok) return error.BadHandshake;
        r.toss(head_len);
    }

    /// После CONNACK: остальным можно писать в соединение, и оно слушает тему комнаты.
    fn subscribe(s: *Signal, c: *Conn, link: *Link) void {
        c.write_mutex.lockUncancelable(s.io);
        defer c.write_mutex.unlock(s.io);
        s.mutex.lockUncancelable(s.io);
        c.connacked = true;
        c.last_ping_us = s.now();
        s.mutex.unlock(s.io);
        c.link = link;
        var buf: [64]u8 = undefined;
        link.sendPacket(mqtt.subscribe(&buf, 1, s.keys.topic())) catch {};
    }
};

// Эталонные значения — из WebCrypto (Node 22), теми же вызовами, что в web/call.js.
test "signal: вывод ключей и печать совпадают с WebCrypto" {
    const k = derive("планёрка-12");
    try std.testing.expectEqualStrings("zvonilka/483b913b5ad5ab9da07671e7b9f56e28", k.topic());
    var want_key: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&want_key, "a65a2301d50a793adc082d83f6a50127f3bbe8818a5719a9179b9c43bbc930ff");
    try std.testing.expectEqual(want_key, k.key);

    const text = "{\"v\":1,\"f\":\"0123456789abcdef\",\"n\":1,\"t\":\"hello\"}";
    var out: [128]u8 = undefined;
    const sealed = seal(&out, &k, @splat(9), text);
    var want: [76]u8 = undefined;
    _ = try std.fmt.hexToBytes(&want, "0909090909090909090909099939a155576b5518c00180aa53d1d2d5ae181b576ca08cb9ec8eb5e5d4bdb360e9568eaf" ++
        "ffa347f6df14e9a32700d4c67f9cb3f752a27f26aa730340845dc635");
    try std.testing.expectEqualSlices(u8, &want, sealed);

    var plain: [128]u8 = undefined;
    try std.testing.expectEqualStrings(text, open(&plain, &k, &want).?);
    // Другая комната, испорченный бит, обрезанное сообщение — не наше.
    const other = derive("test-abc123");
    try std.testing.expectEqualStrings("zvonilka/2980ea65557767489ec10c691eef3dcb", other.topic());
    try std.testing.expectEqual(@as(?[]u8, null), open(&plain, &other, &want));
    want[20] ^= 1;
    try std.testing.expectEqual(@as(?[]u8, null), open(&plain, &k, &want));
    try std.testing.expectEqual(@as(?[]u8, null), open(&plain, &k, want[0..20]));
}

test "signal: уже виденный номер сообщения отбрасывается" {
    var s: Seen = .{};
    try std.testing.expect(!s.fresh(0));
    try std.testing.expect(s.fresh(1));
    try std.testing.expect(!s.fresh(1)); // вторая копия через другой брокер
    try std.testing.expect(s.fresh(3));
    try std.testing.expect(s.fresh(2)); // пришло не по порядку
    try std.testing.expect(!s.fresh(2));
    try std.testing.expect(!s.fresh(3));
    try std.testing.expect(s.fresh(300));
    try std.testing.expect(!s.fresh(3)); // слишком старое: за окном
    try std.testing.expect(s.fresh(45)); // 255 назад: ещё в окне
    try std.testing.expect(!s.fresh(45));
    try std.testing.expect(!s.fresh(44)); // 256 назад
    try std.testing.expect(s.fresh(299));
    try std.testing.expect(s.fresh(236)); // 64 назад: другое слово окна
    try std.testing.expect(!s.fresh(236));
    // Прощание страницы приходит с номером 2^40.
    try std.testing.expect(s.fresh(1 << 40));
    try std.testing.expect(!s.fresh(1 << 40));
    try std.testing.expect(!s.fresh(300));
    // Сдвиг ровно на слово и на слово с остатком не теряет соседние номера.
    var t: Seen = .{};
    try std.testing.expect(t.fresh(10));
    try std.testing.expect(t.fresh(74));
    try std.testing.expect(!t.fresh(10));
    try std.testing.expect(t.fresh(11));
    try std.testing.expect(t.fresh(144));
    try std.testing.expect(!t.fresh(74));
    try std.testing.expect(!t.fresh(11));
    try std.testing.expect(t.fresh(12));
}

test "signal: поток MQTT из кадров WebSocket" {
    // Двоичный кадр «hello», пинг «ab», пустой кадр, понг «zz» (пропускается), кадр с длиной в
    // два байта и его продолжение, затем закрытие.
    var long: [200]u8 = undefined;
    for (&long, 0..) |*x, i| x.* = @truncate(i);
    const stream = [_]u8{ 0x82, 5 } ++ "hello".* ++ [_]u8{ 0x89, 2 } ++ "ab".* ++ [_]u8{ 0x82, 0 } ++ [_]u8{ 0x8a, 2 } ++ "zz".* ++
        [_]u8{ 0x02, 126, 0, 200 } ++ long ++ [_]u8{ 0x80, 3 } ++ "end".* ++ [_]u8{ 0x88, 0 };
    var r: Io.Reader = .fixed(&stream);
    var d: Deframer = .{ .websocket = true };
    var control: ?Deframer.Control = null;
    var dst: [64]u8 = undefined;
    // Читающему отдаётся не больше, чем он просит, и не больше, чем осталось в кадре.
    try std.testing.expectEqual(@as(usize, 3), try d.readSome(&r, dst[0..3], &control));
    try std.testing.expectEqualStrings("hel", dst[0..3]);
    try std.testing.expectEqual(@as(usize, 2), try d.readSome(&r, &dst, &control));
    try std.testing.expectEqualStrings("lo", dst[0..2]);
    try std.testing.expectEqual(@as(usize, 0), try d.readSome(&r, &dst, &control));
    try std.testing.expectEqualStrings("ab", control.?.data[0..control.?.len]);
    control = null;
    var got: [203]u8 = undefined;
    var n: usize = 0;
    while (n < got.len) n += try d.readSome(&r, got[n..][0..@min(64, got.len - n)], &control);
    try std.testing.expectEqualSlices(u8, &long, got[0..200]);
    try std.testing.expectEqualStrings("end", got[200..]);
    try std.testing.expectEqual(@as(?Deframer.Control, null), control);
    try std.testing.expectError(error.ConnectionClosed, d.readSome(&r, &dst, &control));

    // Обрыв посреди кадра и кадр с маской от «сервера».
    var cut: Io.Reader = .fixed(&[_]u8{ 0x82, 5, 'h', 'e' });
    d = .{ .websocket = true };
    try std.testing.expectEqual(@as(usize, 2), try d.readSome(&cut, &dst, &control));
    try std.testing.expectError(error.EndOfStream, d.readSome(&cut, &dst, &control));
    var masked: Io.Reader = .fixed(&[_]u8{ 0x82, 0x85, 1, 2, 3, 4 });
    d = .{ .websocket = true };
    try std.testing.expectError(error.BadFrame, d.readSome(&masked, &dst, &control));

    // Без WebSocket поток идёт как есть.
    var plain: Io.Reader = .fixed("mqtt");
    d = .{ .websocket = false };
    try std.testing.expectEqual(@as(usize, 4), try d.readSome(&plain, &dst, &control));
    try std.testing.expectEqualStrings("mqtt", dst[0..4]);
}

test "signal: пакеты MQTT собираются из кусков, слишком большой пропускается" {
    var one: [64]u8 = undefined;
    var two: [64]u8 = undefined;
    var three: [64]u8 = undefined;
    const p1 = mqtt.publish(&one, "t/1", "первое");
    const p2 = mqtt.publish(&two, "t/2", "второе");
    const p3 = mqtt.publish(&three, "t/3", "третье");
    // Между вторым и третьим — пакет на 300 байт при пределе в 100: его надо пропустить.
    var big: [320]u8 = undefined;
    const filler: [300 - 5]u8 = @splat('x');
    const p_big = mqtt.publish(&big, "big", &filler);
    try std.testing.expectEqual(@as(usize, 303), p_big.len);
    var stream: [512]u8 = undefined;
    var total: usize = 0;
    for ([_][]const u8{ p1, p2, p_big, p3 }) |p| {
        @memcpy(stream[total..][0..p.len], p);
        total += p.len;
    }

    // Любой размер куска — пакеты выходят те же и в том же порядке.
    for ([_]usize{ 1, 2, 7, 50, 512 }) |chunk| {
        var buf: [128]u8 = undefined;
        var a: Assembler = .{ .buf = &buf, .limit = 100 };
        var seen: usize = 0;
        var off: usize = 0;
        while (off < total) {
            const room = a.space();
            try std.testing.expect(room.len > 0);
            const n = @min(@min(chunk, room.len), total - off);
            @memcpy(room[0..n], stream[off..][0..n]);
            a.advance(n);
            off += n;
            while (try a.next()) |p| {
                const msg = mqtt.parsePublish(p).?;
                const want = [_][]const u8{ "первое", "второе", "третье" };
                try std.testing.expect(seen < want.len);
                try std.testing.expectEqualStrings(want[seen], msg.payload);
                seen += 1;
            }
        }
        try std.testing.expectEqual(@as(usize, 3), seen);
        try std.testing.expectEqual(@as(usize, 0), a.skip);
        _ = a.space();
        try std.testing.expectEqual(@as(usize, 0), a.len);
    }

    // Длина, записанная пятью байтами, — не MQTT: соединение рвётся.
    var buf: [128]u8 = undefined;
    var a: Assembler = .{ .buf = &buf, .limit = 100 };
    const bad = [_]u8{ 0x30, 0xff, 0xff, 0xff, 0xff, 0x7f, 0 };
    @memcpy(a.space()[0..bad.len], &bad);
    a.advance(bad.len);
    try std.testing.expectError(error.Malformed, a.next());
}

test "signal: keepalive бросает брокера без CONNACK и замолчавшего" {
    var c: Conn = .{ .connected_at_us = 1_000_000 };
    try std.testing.expectEqual(Verdict.wait, verdict(&c, 1_000_000 + connack_timeout_us));
    try std.testing.expectEqual(Verdict.close, verdict(&c, 1_000_001 + connack_timeout_us));
    c.connacked = true;
    c.last_rx_us.store(2_000_000, .monotonic);
    c.last_ping_us = 2_000_000;
    try std.testing.expectEqual(Verdict.wait, verdict(&c, 2_000_000 + ping_every_us - 1));
    try std.testing.expectEqual(Verdict.ping, verdict(&c, 2_000_000 + ping_every_us));
    try std.testing.expectEqual(Verdict.close, verdict(&c, 2_000_001 + dead_after_us));
}
