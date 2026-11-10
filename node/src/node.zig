//! Узел в комнате Звонилки: пересылающий участник (docs/PLAN.md, этап 3).
//!
//! Узел входит в комнату по коду, как страница, и объявляет себя сообщением hello с полем
//! `node`. Увидев узел, страница строит соединения с участниками не напрямую, а через него:
//! свой offer для участника Б она шлёт узлу (`desc` с полем `peer`), узел отвечает и держит
//! плечо (leg.zig). Когда плечо построил и Б, узел сводит оба в пару и пересылает между ними
//! RTP, RTCP и сообщения канала данных. Пересылка прозрачная: пакеты идут с теми же номерами
//! и метками времени, узел перешифровывает их и переводит номера потоков, типов нагрузки и
//! расширений — у каждого плеча они свои. Потери, повторы, запросы ключевого кадра и оценка
//! полосы остаются делом двух браузеров.
//!
//! Потоки: главный принимает датаграммы с единственного сокета UDP и ведёт таймеры; потоки
//! брокеров (signal.zig) приносят сообщения комнаты; ещё один раз в секунду следит за
//! брокерами и напоминает о себе. Всё состояние — под одним замком `mutex`; в брокеры пишут
//! только потоки сигналинга и только без замка.
const std = @import("std");
const Io = std.Io;
const net = std.Io.net;
const stun = @import("stun.zig");
const sdp = @import("sdp.zig");
const dtls = @import("dtls.zig");
const rtp = @import("rtp.zig");
const rtcp = @import("rtcp.zig");
const srtp = @import("srtp.zig");
const signal = @import("signal.zig");
const netif = @import("netif.zig");
const leg_mod = @import("leg.zig");
const Leg = leg_mod.Leg;
const Id = leg_mod.Id;

pub const StunServer = struct { host: []const u8, port: u16 };

/// Те же, что ICE_SERVERS в web/call.js.
pub const stun_servers = [_]StunServer{
    .{ .host = "stun.l.google.com", .port = 19302 },
    .{ .host = "stun.cloudflare.com", .port = 3478 },
};

/// Версия роли узла в сообщении hello: страница узнаёт по полю `node`, что это не человек.
pub const node_version = 1;

const tick_us: u64 = 10_000;
const hello_every_s = 20;
const stun_every_us: u64 = 25_000_000;
const stats_every_us: u64 = 5_000_000;
const person_ttl_us: u64 = 90_000_000;
const held_ttl_us: u64 = 15_000_000;
const max_legs = 512;
const max_legs_per_person = 32;
const max_people = 96;
/// Датаграмма с запасом под метку SRTP: пакет перешифровывается на месте.
const datagram_max = 2048;
const datagram_room = 64;
const max_candidates = 12;

pub const SrtpChoice = enum { auto, cm, gcm };

pub const Options = struct {
    /// Код комнаты, уже приведённый к виду страницы (room.zig).
    room: []const u8,
    name: []const u8 = "Узел",
    /// Порт UDP для медиа; 0 — любой свободный.
    port: u16 = 0,
    /// Адрес, который узел объявит браузерам вдобавок к найденным: сервер, чей внешний адрес
    /// не виден на его сетевом интерфейсе.
    public_ip: ?[4]u8 = null,
    transport: signal.Transport = .wss,
    srtp: SrtpChoice = .auto,
    /// Писать в журнал каждое событие плеч и счётчики.
    verbose: bool = false,
    /// Для проверки повторов: терять каждый N-й пакет видео при пересылке; 0 — не терять.
    lose_every: u32 = 0,
};

pub const Totals = struct {
    rtp: u64 = 0,
    rtcp: u64 = 0,
    messages: u64 = 0,
    /// Запросы ключевого кадра и повторов, переданные от браузера браузеру.
    pli: u64 = 0,
    fir: u64 = 0,
    nack: u64 = 0,
    /// Запросы ключевого кадра от самого узла: когда пара только что сложилась.
    own_pli: u64 = 0,
    own_fir: u64 = 0,
    /// Пакеты, которым некуда идти: парного плеча ещё нет.
    unpaired: u64 = 0,
    rejected: u64 = 0,
};

/// Участник комнаты, каким его видит узел: счётчик его сообщений и имя для журнала.
const Person = struct {
    used: bool = false,
    id: Id = undefined,
    seen: signal.Seen = .{},
    name_buf: [80]u8 = undefined,
    name_len: usize = 0,
    heard_us: u64 = 0,
    greeted: bool = false,

    fn name(p: *const Person) []const u8 {
        return p.name_buf[0..p.name_len];
    }

    /// Имя из hello: не длиннее буфера и не посреди знака; управляющие символы в журнал не идут.
    fn rename(p: *Person, new_name: []const u8) void {
        if (new_name.len == 0 or !std.unicode.utf8ValidateSlice(new_name)) return;
        var len: usize = 0;
        var view = std.unicode.Utf8View.initUnchecked(new_name);
        var it = view.iterator();
        while (it.nextCodepointSlice()) |cp| {
            if (cp.len == 1 and (cp[0] < 0x20 or cp[0] == 0x7f)) continue;
            if (len + cp.len > p.name_buf.len) break;
            @memcpy(p.name_buf[len..][0..cp.len], cp);
            len += cp.len;
        }
        if (len > 0) p.name_len = len;
    }
};

/// Кандидат, пришедший раньше описания: ждёт своё плечо.
const HeldCandidate = struct { owner: Id, peer: Id, addr: net.IpAddress, at_us: u64 };

const AddrKey = [18]u8;

fn addrKey(a: net.IpAddress) AddrKey {
    var k: AddrKey = undefined;
    switch (leg_mod.normalize(a)) {
        .ip4 => |v| {
            @memset(k[0..10], 0);
            k[10] = 0xff;
            k[11] = 0xff;
            @memcpy(k[12..16], &v.bytes);
            std.mem.writeInt(u16, k[16..18], v.port, .big);
        },
        .ip6 => |v| {
            @memcpy(k[0..16], &v.bytes);
            std.mem.writeInt(u16, k[16..18], v.port, .big);
        },
    }
    return k;
}

/// Сообщение комнаты: поля те же, что у страницы (web/call.js), плюс `peer` и `node`.
const Msg = struct {
    v: u32 = 0,
    f: []const u8 = "",
    n: u64 = 0,
    t: []const u8 = "",
    to: []const u8 = "",
    /// Ради какого участника соединение, о котором сообщение.
    peer: []const u8 = "",
    name: []const u8 = "",
    /// У hello узла — версия его роли.
    node: u32 = 0,
    d: ?struct { type: []const u8 = "", sdp: []const u8 = "" } = null,
    c: ?[]const struct { candidate: []const u8 = "" } = null,
};

pub fn validId(s: []const u8) bool {
    if (s.len != 16) return false;
    for (s) |ch| switch (ch) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

pub const Node = struct {
    gpa: std.mem.Allocator,
    io: Io,
    opts: Options,
    sock: net.Socket,
    /// Сокет IPv6 с отображёнными адресами IPv4; false — только IPv4.
    dual: bool,
    identity: dtls.Identity,
    id: Id,
    sig: ?*signal.Signal = null,
    srtp_profiles: []const u16,

    mutex: Io.Mutex = .init,
    legs: std.ArrayList(*Leg) = .empty,
    /// Адрес браузера, доказавший знание пароля ICE, → его плечо.
    by_addr: std.AutoHashMapUnmanaged(AddrKey, *Leg) = .empty,
    people: [max_people]Person = @splat(.{}),
    held: [48]HeldCandidate = undefined,
    held_count: usize = 0,

    /// Свои адреса для браузеров: адреса сетевых интерфейсов и такие, какими узел виден снаружи.
    local: [netif.max][4]u8 = undefined,
    local_count: usize = 0,
    srflx: [4]net.IpAddress = undefined,
    srflx_count: usize = 0,
    stun_targets: [4]net.IpAddress = undefined,
    stun_target_count: usize = 0,
    stun_pending: [8]struct { tid: [12]u8, to: net.IpAddress } = undefined,
    stun_pending_count: usize = 0,
    next_stun_us: u64 = 0,

    out_n: std.atomic.Value(u64) = .init(0),
    stopping: std.atomic.Value(bool) = .init(false),
    totals: Totals = .{},
    logged: Totals = .{},
    next_stats_us: u64 = 0,
    started_us: u64 = 0,
    lose_count: u32 = 0,

    pub fn create(gpa: std.mem.Allocator, io: Io, opts: Options) !*Node {
        var sock: net.Socket = undefined;
        var dual = true;
        const any6 = net.IpAddress.parse("::", opts.port) catch unreachable;
        if (any6.bind(io, .{ .mode = .dgram, .ip6_only = false })) |s6| {
            sock = s6;
        } else |_| {
            const any4 = net.IpAddress.parse("0.0.0.0", opts.port) catch unreachable;
            sock = try any4.bind(io, .{ .mode = .dgram });
            dual = false;
        }
        errdefer sock.close(io);

        const n = try gpa.create(Node);
        errdefer gpa.destroy(n);
        var id_bytes: [8]u8 = undefined;
        io.random(&id_bytes);
        n.* = .{
            .gpa = gpa,
            .io = io,
            .opts = opts,
            .sock = sock,
            .dual = dual,
            .identity = try dtls.Identity.generate(io),
            .id = std.fmt.bytesToHex(id_bytes, .lower),
            .srtp_profiles = switch (opts.srtp) {
                .auto => &leg_mod.srtp_gcm_first,
                .cm => &leg_mod.srtp_cm_only,
                .gcm => &leg_mod.srtp_gcm_only,
            },
        };
        n.local_count = netif.addresses(io, &n.local);
        n.started_us = n.now();
        return n;
    }

    pub fn port(n: *const Node) u16 {
        return n.sock.address.getPort();
    }

    fn now(n: *Node) u64 {
        return @intCast(@divTrunc(Io.Clock.awake.now(n.io).nanoseconds, 1000));
    }

    fn lock(n: *Node) void {
        n.mutex.lockUncancelable(n.io);
    }

    fn unlock(n: *Node) void {
        n.mutex.unlock(n.io);
    }

    /// Строка журнала; перед ней — секунды от запуска узла.
    pub fn log(n: *Node, comptime fmt: []const u8, args: anytype) void {
        const ms = (n.now() -| n.started_us) / 1000;
        std.debug.print("{d:>5}.{d:0>3} " ++ fmt ++ "\n", .{ ms / 1000, ms % 1000 } ++ args);
    }

    fn detail(n: *Node, comptime fmt: []const u8, args: anytype) void {
        if (n.opts.verbose) n.log(fmt, args);
    }

    // ------------------------------------------------------------------ запуск и главный цикл

    /// Входит в комнату и пересылает, пока не попросят остановиться (`stop`).
    pub fn run(n: *Node) !void {
        n.gather();
        var cands_buf: [max_candidates]sdp.Candidate = undefined;
        const cands = n.candidates(&cands_buf);
        n.log("узел {s}: порт UDP {d}, адресов для браузеров: {d}", .{ &n.id, n.port(), cands.len });
        for (cands) |c| {
            var ip_buf: [64]u8 = undefined;
            n.detail("  {s} {s}:{d}", .{ if (c.kind == .host) "свой" else "внешний", sdp.formatIp(&ip_buf, c.addr), c.addr.getPort() });
        }

        const sig = try signal.Signal.create(n.gpa, n.io, signal.derive(n.opts.room), .{
            .transport = n.opts.transport,
            .handler = onSignal,
            .ready = onBrokerReady,
            .ctx = n,
            .log_fn = logLine,
        });
        n.sig = sig;
        try sig.start();
        const timer = try std.Thread.spawn(.{ .stack_size = 512 * 1024 }, signalTimer, .{n});
        timer.detach();

        const buf = try n.gpa.alloc(u8, datagram_max);
        defer n.gpa.free(buf);
        var last_tick: u64 = 0;
        while (!n.stopping.load(.acquire)) {
            const t = n.now();
            if (t -| last_tick >= tick_us) {
                last_tick = t;
                n.lock();
                n.timers(t);
                n.unlock();
            }
            const msg = n.sock.receiveTimeout(n.io, buf[0 .. datagram_max - datagram_room], .{ .duration = .{ .raw = .fromMilliseconds(tick_us / 1000), .clock = .awake } }) catch |e| switch (e) {
                error.Timeout => continue,
                error.Canceled => break,
                else => {
                    // Сюда возвращаются ошибки ICMP от кандидата, который не отвечает; работаем дальше.
                    n.io.sleep(.fromMilliseconds(2), .awake) catch {};
                    continue;
                },
            };
            n.lock();
            n.onDatagram(leg_mod.normalize(msg.from), buf, msg.data.len);
            n.unlock();
        }
        n.shutdown();
    }

    /// Просит главный цикл закончить. Можно звать из обработчика сигнала.
    pub fn stop(n: *Node) void {
        n.stopping.store(true, .release);
    }

    fn shutdown(n: *Node) void {
        n.log("узел выходит из комнаты", .{});
        n.sendPlain("bye", null);
        n.lock();
        for (n.legs.items) |l| l.kill("узел остановлен");
        n.unlock();
        // Прощанию и закрывающим пакетам нужно время уйти.
        n.io.sleep(.fromMilliseconds(300), .awake) catch {};
    }

    fn logLine(ctx: *anyopaque, msg: []const u8) void {
        const n: *Node = @ptrCast(@alignCast(ctx));
        n.log("{s}", .{msg});
    }

    fn onBrokerReady(ctx: *anyopaque) void {
        const n: *Node = @ptrCast(@alignCast(ctx));
        n.sendHello(null);
    }

    fn signalTimer(n: *Node) void {
        var beats: u32 = 0;
        while (!n.stopping.load(.acquire)) {
            n.io.sleep(.fromMilliseconds(1000), .awake) catch return;
            const sig = n.sig orelse continue;
            sig.keepalive();
            beats += 1;
            if (beats % hello_every_s == 0) n.sendHello(null);
        }
    }

    // ------------------------------------------------------------------ свои адреса

    /// Адреса, какими узел виден снаружи: спрашивает серверы STUN со своего сокета медиа.
    fn gather(n: *Node) void {
        for (stun_servers) |srv| {
            const host_name = net.HostName.init(srv.host) catch continue;
            var results: [16]net.HostName.LookupResult = undefined;
            var q: Io.Queue(net.HostName.LookupResult) = .init(&results);
            host_name.lookup(n.io, &q, .{ .port = srv.port }) catch continue;
            var v4 = false;
            var v6 = false;
            while (q.getOne(n.io)) |r| switch (r) {
                .address => |a| {
                    // По одному адресу каждого семейства на сервер достаточно.
                    if (n.stun_target_count == n.stun_targets.len or (a == .ip4 and v4) or (a == .ip6 and (v6 or !n.dual))) continue;
                    if (a == .ip4) v4 = true else v6 = true;
                    n.stun_targets[n.stun_target_count] = a;
                    n.stun_target_count += 1;
                },
                .canonical_name => {},
            } else |_| {}
        }
        // Ждём ответы недолго: кто не успел, дойдёт уже в главном цикле.
        const deadline = n.now() + 700_000;
        var buf: [1500]u8 = undefined;
        n.askStun();
        var asked: u64 = n.now();
        while (n.now() < deadline and n.stun_pending_count > 0) {
            if (n.now() -| asked > 250_000) {
                asked = n.now();
                n.askStun();
            }
            const msg = n.sock.receiveTimeout(n.io, &buf, .{ .duration = .{ .raw = .fromMilliseconds(20), .clock = .awake } }) catch continue;
            if (stun.parse(msg.data)) |m| _ = n.onStunAnswer(&m);
        }
        n.next_stun_us = n.now() + stun_every_us;
    }

    fn askStun(n: *Node) void {
        n.stun_pending_count = 0;
        for (n.stun_targets[0..n.stun_target_count]) |to| {
            var tid: [12]u8 = undefined;
            n.io.random(&tid);
            var b: [512]u8 = undefined;
            var m = stun.Builder.init(&b, stun.binding_request, tid);
            m.addFingerprint();
            if (!n.sendToOk(to, m.bytes())) continue; // нет пути (IPv6 без IPv6): ответа не ждём
            n.stun_pending[n.stun_pending_count] = .{ .tid = tid, .to = to };
            n.stun_pending_count += 1;
        }
    }

    /// Ответ сервера STUN на вопрос узла: запоминает внешний адрес. true — ответ был наш.
    fn onStunAnswer(n: *Node, m: *const stun.Message) bool {
        if (m.msg_type != stun.binding_success) return false;
        for (n.stun_pending[0..n.stun_pending_count], 0..) |c, i| {
            if (!std.mem.eql(u8, &c.tid, &m.tid)) continue;
            n.stun_pending[i] = n.stun_pending[n.stun_pending_count - 1];
            n.stun_pending_count -= 1;
            const mapped_addr = leg_mod.normalize(m.xor_mapped orelse return true);
            if (!leg_mod.routable(mapped_addr)) return true;
            for (n.srflx[0..n.srflx_count]) |*x| if (x.eql(&mapped_addr)) return true;
            if (n.srflx_count == n.srflx.len) {
                // Адрес сменился (другая сеть): старые больше не нужны.
                n.srflx_count = 0;
            }
            n.srflx[n.srflx_count] = mapped_addr;
            n.srflx_count += 1;
            return true;
        }
        return false;
    }

    /// Кандидаты узла для ответа браузеру: заданный внешний адрес, адреса интерфейсов и то,
    /// что показали серверы STUN. Повторы выбрасываются.
    fn candidates(n: *Node, out: *[max_candidates]sdp.Candidate) []const sdp.Candidate {
        var count: usize = 0;
        const p = n.port();
        const Add = struct {
            fn one(list: *[max_candidates]sdp.Candidate, len: *usize, c: sdp.Candidate) void {
                if (len.* == list.len) return;
                for (list[0..len.*]) |*have| if (have.addr.eql(&c.addr)) return;
                list[len.*] = c;
                len.* += 1;
            }
        };
        if (n.opts.public_ip) |ip| Add.one(out, &count, .{ .addr = .{ .ip4 = .{ .bytes = ip, .port = p } }, .kind = .host });
        for (n.local[0..n.local_count]) |ip| Add.one(out, &count, .{ .addr = .{ .ip4 = .{ .bytes = ip, .port = p } }, .kind = .host });
        // Без сети остаётся петля: годится только браузеру на том же компьютере.
        if (count == 0) Add.one(out, &count, .{ .addr = .{ .ip4 = .{ .bytes = .{ 127, 0, 0, 1 }, .port = p } }, .kind = .host });
        for (n.srflx[0..n.srflx_count]) |a| Add.one(out, &count, .{ .addr = a, .kind = .srflx });
        return out[0..count];
    }

    fn sendTo(ctx: *anyopaque, to: net.IpAddress, data: []const u8) void {
        const n: *Node = @ptrCast(@alignCast(ctx));
        _ = n.sendToOk(to, data);
    }

    fn sendToOk(n: *Node, to: net.IpAddress, data: []const u8) bool {
        var dest = to;
        if (n.dual and to == .ip4) dest = leg_mod.mapped(to.ip4);
        n.sock.send(n.io, &dest, data) catch return false;
        return true;
    }

    fn host(n: *Node) leg_mod.Host {
        return .{ .ctx = n, .send = sendTo, .message = onMessage };
    }

    // ------------------------------------------------------------------ сигналинг

    /// Сообщение комнаты, уже расшифрованное. Зовётся из потоков брокеров.
    fn onSignal(ctx: *anyopaque, text: []const u8) void {
        const n: *Node = @ptrCast(@alignCast(ctx));
        var arena: std.heap.ArenaAllocator = .init(n.gpa);
        defer arena.deinit();
        const m = std.json.parseFromSliceLeaky(Msg, arena.allocator(), text, .{ .ignore_unknown_fields = true }) catch return;
        if (m.v != 1 or !validId(m.f) or std.mem.eql(u8, m.f, &n.id)) return;
        const from: Id = m.f[0..16].*;

        var reply: ?[]u8 = null;
        defer if (reply) |r| n.gpa.free(r);
        var greet = false;
        {
            n.lock();
            defer n.unlock();
            const t = n.now();
            const person = n.personFor(from, t) orelse return;
            if (!person.seen.fresh(m.n)) return; // вторая копия через другой брокер или повтор
            if (m.to.len > 0 and !std.mem.eql(u8, m.to, &n.id)) return;
            person.heard_us = t;
            if (std.mem.eql(u8, m.t, "hello")) {
                if (m.node != 0) return; // другой узел в комнате: страницы выберут один сами
                person.rename(m.name);
                if (!person.greeted) {
                    person.greeted = true;
                    n.log("в комнате {s} ({s})", .{ person.name(), from[0..6] });
                }
                // Тому, кто только вошёл, отвечаем сразу, не дожидаясь своего напоминания.
                greet = m.to.len == 0;
            } else if (std.mem.eql(u8, m.t, "desc")) {
                const d = m.d orelse return;
                if (!std.mem.eql(u8, d.type, "offer") or !validId(m.peer)) return;
                reply = n.onOffer(from, m.peer[0..16].*, d.sdp, t);
            } else if (std.mem.eql(u8, m.t, "cand")) {
                const list = m.c orelse return;
                if (!validId(m.peer)) return;
                for (list[0..@min(list.len, 40)]) |c| {
                    const addr = sdp.parseCandidate(c.candidate) orelse continue;
                    n.onCandidate(from, m.peer[0..16].*, addr, t);
                }
            } else if (std.mem.eql(u8, m.t, "bye")) {
                n.onBye(person);
            }
        }
        // В брокеры пишем без замка: брокер, который перестал читать, не должен остановить медиа.
        if (greet) n.sendHello(&from);
        if (reply) |r| if (n.sig) |sig| sig.send(r);
    }

    fn personFor(n: *Node, id: Id, t: u64) ?*Person {
        var free: ?*Person = null;
        var stalest: ?*Person = null;
        for (&n.people) |*p| {
            if (!p.used) {
                free = free orelse p;
                continue;
            }
            if (std.mem.eql(u8, &p.id, &id)) return p;
            if (stalest == null or p.heard_us < stalest.?.heard_us) stalest = p;
        }
        // Мест нет: уступает тот, кого дольше всех не слышно, если у него нет соединений.
        const slot = free orelse blk: {
            const s = stalest orelse return null;
            if (n.legCount(s.id) > 0) return null;
            break :blk s;
        };
        slot.* = .{ .used = true, .id = id, .heard_us = t };
        const default_name = "Гость";
        @memcpy(slot.name_buf[0..default_name.len], default_name);
        slot.name_len = default_name.len;
        return slot;
    }

    /// Как участник зовётся в журнале: именем, а пока оно неизвестно — началом идентификатора.
    fn who(n: *Node, id: Id, buf: *[7]u8) []const u8 {
        for (&n.people) |*p| {
            if (p.used and p.greeted and std.mem.eql(u8, &p.id, &id)) return p.name();
        }
        buf[0] = '#';
        @memcpy(buf[1..7], id[0..6]);
        return buf;
    }

    fn legCount(n: *Node, owner: Id) usize {
        var count: usize = 0;
        for (n.legs.items) |l| {
            if (!l.dead and std.mem.eql(u8, &l.owner, &owner)) count += 1;
        }
        return count;
    }

    fn findLeg(n: *Node, owner: Id, peer: Id) ?*Leg {
        for (n.legs.items) |l| {
            if (!l.dead and std.mem.eql(u8, &l.owner, &owner) and std.mem.eql(u8, &l.peer, &peer)) return l;
        }
        return null;
    }

    /// Offer браузера `owner` для связи с участником `peer`. Возвращает готовое сообщение
    /// с ответом (его освобождает вызывающий) или null.
    fn onOffer(n: *Node, owner: Id, peer: Id, text: []const u8, t: u64) ?[]u8 {
        if (std.mem.eql(u8, &owner, &peer) or std.mem.eql(u8, &peer, &n.id)) return null;
        const o = sdp.parseOffer(text) catch |e| {
            var b1: [7]u8 = undefined;
            n.log("описание от {s} не годится: {t}", .{ n.who(owner, &b1), e });
            return null;
        };
        var cands_buf: [max_candidates]sdp.Candidate = undefined;
        const cands = n.candidates(&cands_buf);
        if (n.findLeg(owner, peer)) |l| {
            if (std.mem.eql(u8, l.sessionId(), o.session_id)) {
                // Тот же сеанс: либо описание пришло повторно, либо браузер перезапускает ICE.
                if (!std.mem.eql(u8, l.remoteUfrag(), o.ufrag)) {
                    l.restartIce(&o, t) catch return null;
                    l.describe(&o, cands) catch return null;
                    var b1: [7]u8 = undefined;
                    var b2: [7]u8 = undefined;
                    n.log("{s} → {s}: перезапуск ICE", .{ n.who(owner, &b1), n.who(peer, &b2) });
                }
                return n.answerMessage(l);
            }
            // Браузер построил соединение заново: прежнее плечо уходит, пара остаётся.
            l.kill("заменено новым соединением");
            n.unlink(l, false);
        }
        if (n.legs.items.len >= max_legs or n.legCount(owner) >= max_legs_per_person) {
            var b1: [7]u8 = undefined;
            n.log("{s}: слишком много соединений, отказ", .{n.who(owner, &b1)});
            return null;
        }
        const l = Leg.create(n.gpa, n.io, n.host(), &n.identity, n.srtp_profiles, owner, peer, &o, n.dual, t) catch |e| {
            n.log("плечо не создано: {t}", .{e});
            return null;
        };
        l.describe(&o, cands) catch {
            l.destroy(n.gpa);
            return null;
        };
        n.legs.append(n.gpa, l) catch {
            l.destroy(n.gpa);
            return null;
        };
        // Кандидаты, обогнавшие описание.
        var i: usize = 0;
        while (i < n.held_count) {
            const h = n.held[i];
            if (std.mem.eql(u8, &h.owner, &owner) and std.mem.eql(u8, &h.peer, &peer)) {
                _ = l.addCandidate(h.addr, t);
                n.held[i] = n.held[n.held_count - 1];
                n.held_count -= 1;
            } else i += 1;
        }
        if (n.findLeg(peer, owner)) |other| {
            l.partner = other;
            other.partner = l;
        }
        var b1: [7]u8 = undefined;
        var b2: [7]u8 = undefined;
        n.detail("{s} → {s}: плечо создано, каналов {d}{s}", .{ n.who(owner, &b1), n.who(peer, &b2), l.track_count, if (l.partner != null) ", пара есть" else "" });
        return n.answerMessage(l);
    }

    fn onCandidate(n: *Node, owner: Id, peer: Id, addr: net.IpAddress, t: u64) void {
        if (n.findLeg(owner, peer)) |l| {
            _ = l.addCandidate(addr, t);
            return;
        }
        if (n.held_count == n.held.len) {
            std.mem.copyForwards(HeldCandidate, n.held[0 .. n.held.len - 1], n.held[1..]);
            n.held_count -= 1;
        }
        n.held[n.held_count] = .{ .owner = owner, .peer = peer, .addr = addr, .at_us = t };
        n.held_count += 1;
    }

    /// Участник вышел: его плечи закрываются, а с ними — парные.
    fn onBye(n: *Node, person: *Person) void {
        if (person.greeted) n.log("вышел {s} ({s})", .{ person.name(), person.id[0..6] });
        for (n.legs.items) |l| {
            if (std.mem.eql(u8, &l.owner, &person.id)) l.kill("участник вышел");
        }
        person.greeted = false;
    }

    // ------------------------------------------------------------------ свои сообщения

    fn nextN(n: *Node) u64 {
        return n.out_n.fetchAdd(1, .monotonic) + 1;
    }

    /// hello узла: всем или одному участнику.
    fn sendHello(n: *Node, to: ?*const Id) void {
        var w: std.Io.Writer.Allocating = .init(n.gpa);
        defer w.deinit();
        n.writeHead(&w.writer, "hello", to) catch return;
        w.writer.print(",\"node\":{d},\"name\":", .{node_version}) catch return;
        writeJsonString(&w.writer, n.opts.name) catch return;
        w.writer.writeByte('}') catch return;
        if (n.sig) |sig| sig.send(w.written());
    }

    /// Сообщение без содержимого: bye.
    fn sendPlain(n: *Node, kind: []const u8, to: ?*const Id) void {
        var w: std.Io.Writer.Allocating = .init(n.gpa);
        defer w.deinit();
        n.writeHead(&w.writer, kind, to) catch return;
        w.writer.writeByte('}') catch return;
        if (n.sig) |sig| sig.send(w.written());
    }

    fn writeHead(n: *Node, w: *std.Io.Writer, kind: []const u8, to: ?*const Id) !void {
        try w.print("{{\"v\":1,\"f\":\"{s}\",\"n\":{d},\"t\":\"{s}\"", .{ &n.id, n.nextN(), kind });
        if (to) |id| try w.print(",\"to\":\"{s}\"", .{id});
    }

    /// Сообщение с ответом плеча: desc для его браузера с пометкой, ради кого соединение.
    fn answerMessage(n: *Node, l: *Leg) ?[]u8 {
        var w: std.Io.Writer.Allocating = .init(n.gpa);
        defer w.deinit();
        n.writeHead(&w.writer, "desc", &l.owner) catch return null;
        w.writer.print(",\"peer\":\"{s}\",\"d\":{{\"type\":\"answer\",\"sdp\":", .{&l.peer}) catch return null;
        writeJsonString(&w.writer, l.answer()) catch return null;
        w.writer.writeAll("}}") catch return null;
        return w.toOwnedSlice() catch null;
    }

    // ------------------------------------------------------------------ датаграммы

    /// Датаграмма с сокета: `buf[0..len]`, после неё в буфере есть запас.
    fn onDatagram(n: *Node, from: net.IpAddress, buf: []u8, len: usize) void {
        if (len == 0) return;
        const data = buf[0..len];
        const t = n.now();
        if (stun.isStun(data)) return n.onStun(from, data, t);
        const l = n.by_addr.get(addrKey(from)) orelse return;
        if (l.dead) return;
        if (data[0] >= 20 and data[0] <= 63) {
            l.onDtls(from, data, t);
            n.notice(l);
        } else if (rtp.isRtpOrRtcp(data)) {
            if (!l.media_ready) return;
            if (rtp.isRtcp(data)) n.onRtcp(l, from, buf, len, t) else n.onRtp(l, from, buf, len, t);
        }
    }

    fn onStun(n: *Node, from: net.IpAddress, data: []const u8, t: u64) void {
        const m = stun.parse(data) orelse return;
        switch (m.msg_type) {
            stun.binding_request => {
                // Чьё плечо — видно по логину; пароль проверит само плечо.
                for (n.legs.items) |l| {
                    if (l.dead or !l.ownsRequest(&m)) continue;
                    if (l.onBindingRequest(from, &m, t)) n.bind(from, l);
                    return;
                }
            },
            stun.binding_success => {
                if (n.onStunAnswer(&m)) return;
                for (n.legs.items) |l| {
                    if (l.dead) continue;
                    if (l.onBindingSuccess(&m, t)) |addr| {
                        n.bind(addr, l);
                        return;
                    }
                }
            },
            else => {},
        }
    }

    fn bind(n: *Node, addr: net.IpAddress, l: *Leg) void {
        n.by_addr.put(n.gpa, addrKey(addr), l) catch {};
    }

    /// Замечает, что рукопожатие плеча закончилось или поднялся его канал данных.
    fn notice(n: *Node, l: *Leg) void {
        var b1: [7]u8 = undefined;
        var b2: [7]u8 = undefined;
        if (l.established() and !l.noticed) {
            l.noticed = true;
            var ip_buf: [64]u8 = undefined;
            n.log("{s} → {s}: соединение есть, {s}, {s}", .{ n.who(l.owner, &b1), n.who(l.peer, &b2), l.peerAddress(&ip_buf), if (l.profile) |profile| profile.name() else "без медиа" });
            // Браузер пары шлёт видео уже давно: новому зрителю нужен ключевой кадр.
            if (l.partner) |p| n.askKeyframes(p);
        }
        if (!l.data_ready and l.dataOpen()) {
            l.data_ready = true;
            if (l.partner) |p| {
                if (p.dataOpen()) {
                    n.log("{s} ↔ {s}: пара соединена через узел", .{ n.who(l.owner, &b1), n.who(l.peer, &b2) });
                    p.flushHeld(l);
                    l.flushHeld(p);
                }
            }
        }
    }

    /// Просит браузер плеча о ключевом кадре в каждом видеоканале от имени узла: через PLI,
    /// а где о нём не договорились — через FIR.
    fn askKeyframes(n: *Node, l: *Leg) void {
        if (l.dead or !l.media_ready) return;
        for (l.tracks[0..l.track_count]) |*tr| {
            if (tr.kind != .video or !tr.receives or tr.remote_ssrc == 0) continue;
            var buf: [rtcp.fir_len + srtp.max_overhead]u8 = undefined;
            var plain: usize = 0;
            if (tr.pli) {
                plain = rtcp.writePli(buf[0..rtcp.pli_len], tr.local_ssrc, tr.remote_ssrc).len;
                n.totals.own_pli += 1;
            } else if (tr.fir) {
                tr.fir_seq +%= 1;
                plain = rtcp.writeFir(buf[0..rtcp.fir_len], tr.local_ssrc, tr.remote_ssrc, tr.fir_seq).len;
                n.totals.own_fir += 1;
            } else continue;
            const len = l.srtp_out.protectRtcp(&buf, plain) catch continue;
            l.send(buf[0..len]);
        }
    }

    /// Пакет RTP от браузера плеча `l` — в парное плечо.
    fn onRtp(n: *Node, l: *Leg, from: net.IpAddress, buf: []u8, len: usize, t: u64) void {
        const plain = l.srtp_in.unprotectRtp(buf[0..len]) catch {
            l.stats.rejected += 1;
            n.totals.rejected += 1;
            return;
        };
        l.heardFrom(from, t);
        l.stats.rtp_in += 1;
        const h = rtp.parse(plain) orelse return;
        const mid_id = if (l.track_count > 0) l.tracks[0].extId(.mid) else 0;
        const found = l.findTrack(h.ssrc, h.pt, rtp.extension(plain, h, mid_id)) orelse {
            l.stats.unknown += 1;
            return;
        };
        const src = &l.tracks[found.track];
        const want_pt: u7 = if (found.rtx) (src.rtx_pt orelse return) else src.pt;
        if (h.pt != want_pt) {
            l.stats.unknown += 1;
            return;
        }
        const p = l.partner orelse {
            n.totals.unpaired += 1;
            return;
        };
        if (p.dead or !p.media_ready or found.track >= p.track_count) {
            n.totals.unpaired += 1;
            return;
        }
        const dst = &p.tracks[found.track];
        if (dst.kind != src.kind or !dst.sends) return;
        if (n.opts.lose_every != 0 and src.kind == .video and !found.rtx) {
            // Проверка повторов: пакет «теряется», получатель попросит его снова (NACK).
            n.lose_count += 1;
            if (n.lose_count % n.opts.lose_every == 0) return;
        }
        // Тот же кодек на другом плече может идти под другим номером; повторам нужен свой.
        const out_pt: u7 = if (found.rtx) (dst.rtx_pt orelse return) else dst.pt;
        rtp.setPayloadType(plain, out_pt);
        rtp.setSsrc(plain, if (found.rtx) dst.local_rtx else dst.local_ssrc);
        var rw: rtp.ExtRewrite = .{ .mid_id = src.extId(.mid), .mid = dst.mid() };
        for (src.ext[0..src.ext_count]) |x| rw.map[x.id] = dst.extId(x.ext);
        rtp.rewriteExtensions(plain, h, &rw);
        const out_len = p.srtp_out.protectRtp(buf, plain.len) catch return;
        p.send(buf[0..out_len]);
        p.stats.rtp_out += 1;
        n.totals.rtp += 1;
    }

    /// Составной пакет RTCP от браузера плеча `l` — в парное плечо, с переводом SSRC.
    fn onRtcp(n: *Node, l: *Leg, from: net.IpAddress, buf: []u8, len: usize, t: u64) void {
        const plain = l.srtp_in.unprotectRtcp(buf[0..len]) catch {
            l.stats.rejected += 1;
            n.totals.rejected += 1;
            return;
        };
        l.heardFrom(from, t);
        l.stats.rtcp_in += 1;
        const p = l.partner orelse return;
        if (p.dead or !p.media_ready) return;
        var seen: rtcp.Seen = .{};
        const pair: Pair = .{ .from = l, .to = p };
        const out = rtcp.translate(plain, .{ .ctx = &pair, .map = Pair.map }, &seen);
        if (out < 8) return;
        const out_len = p.srtp_out.protectRtcp(buf, out) catch return;
        p.send(buf[0..out_len]);
        p.stats.rtcp_out += 1;
        n.totals.rtcp += 1;
        n.totals.pli += seen.pli;
        n.totals.fir += seen.fir;
        n.totals.nack += seen.nack;
    }

    /// Перевод SSRC из плеча `from` в плечо `to`: свои потоки браузера `from` браузер `to`
    /// видит под номерами узла, а потоки, о которых `from` отчитывается, — это потоки `to`.
    const Pair = struct {
        from: *const Leg,
        to: *const Leg,

        fn map(ctx: *const anyopaque, ssrc: u32) u32 {
            const pair: *const Pair = @ptrCast(@alignCast(ctx));
            const count = @min(pair.from.track_count, pair.to.track_count);
            for (pair.from.tracks[0..count], pair.to.tracks[0..count]) |*a, *b| {
                if (a.kind != b.kind) continue;
                if (ssrc == a.remote_ssrc and ssrc != 0) return b.local_ssrc;
                if (ssrc == a.remote_rtx and ssrc != 0) return b.local_rtx;
                if (ssrc == a.local_ssrc) return if (b.remote_ssrc != 0) b.remote_ssrc else ssrc;
                if (ssrc == a.local_rtx) return if (b.remote_rtx != 0) b.remote_rtx else ssrc;
            }
            return ssrc;
        }
    };

    /// Сообщение канала данных от браузера плеча `l` — в парное плечо; пока его нет, ждёт.
    fn onMessage(ctx: *anyopaque, l: *Leg, ppid: u32, data: []const u8) void {
        const n: *Node = @ptrCast(@alignCast(ctx));
        if (l.partner) |p| {
            // Порядок сообщений сохраняется: пока что-то ждёт, новое встаёт за ним.
            if (l.outbox.count == 0 and p.sendMessage(ppid, data)) {
                n.totals.messages += 1;
                return;
            }
        }
        l.hold(ppid, data);
    }

    // ------------------------------------------------------------------ таймеры

    fn timers(n: *Node, t: u64) void {
        for (n.legs.items) |l| {
            l.tick(t);
            if (l.dead) continue;
            n.notice(l);
            if (l.outbox.count > 0) if (l.partner) |p| {
                const before = l.outbox.count;
                l.flushHeld(p);
                n.totals.messages += before - l.outbox.count;
            };
        }
        // Закрытые плечи уходят вместе с парой: участник, чей собеседник отключился, увидит это
        // по закрытому каналу данных, как при прямом соединении.
        var i: usize = 0;
        while (i < n.legs.items.len) {
            const l = n.legs.items[i];
            if (!l.dead) {
                i += 1;
                continue;
            }
            if (l.noticed or n.opts.verbose) {
                var b1: [7]u8 = undefined;
                var b2: [7]u8 = undefined;
                n.log("{s} → {s}: плечо закрыто — {s} (принято RTP {d}, отдано {d}, отброшено {d})", .{ n.who(l.owner, &b1), n.who(l.peer, &b2), l.reason, l.stats.rtp_in, l.stats.rtp_out, l.stats.rejected + l.stats.unknown });
            }
            n.unlink(l, true);
            i = 0; // список изменился, а пара могла стоять раньше
        }
        if (t >= n.next_stun_us) {
            n.next_stun_us = t + stun_every_us;
            // Сеть могла смениться: адреса интерфейсов перечитываем заодно.
            var fresh: [netif.max][4]u8 = undefined;
            const count = netif.addresses(n.io, &fresh);
            if (count > 0) {
                n.local = fresh;
                n.local_count = count;
            }
            n.askStun();
        }
        // Кандидаты, чьё описание так и не пришло, и участники, которых давно не слышно.
        var k: usize = 0;
        while (k < n.held_count) {
            if (t -| n.held[k].at_us > held_ttl_us) {
                n.held[k] = n.held[n.held_count - 1];
                n.held_count -= 1;
            } else k += 1;
        }
        for (&n.people) |*p| {
            if (p.used and t -| p.heard_us > person_ttl_us and n.legCount(p.id) == 0) {
                if (p.greeted) n.log("пропал {s} ({s})", .{ p.name(), p.id[0..6] });
                p.used = false;
            }
        }
        if (t >= n.next_stats_us) {
            n.next_stats_us = t + stats_every_us;
            const a = n.totals;
            if (a.rtp != n.logged.rtp or a.rtcp != n.logged.rtcp or a.messages != n.logged.messages) {
                n.logged = a;
                n.log("переслано: RTP {d}, RTCP {d}, сообщений {d}; запросов кадра: PLI {d}, FIR {d}; NACK {d}; плеч {d}", .{ a.rtp, a.rtcp, a.messages, a.pli, a.fir, a.nack, n.legs.items.len });
                n.detail("  своих запросов кадра: PLI {d}, FIR {d}; пакетов без пары {d}, отброшено {d}", .{ a.own_pli, a.own_fir, a.unpaired, a.rejected });
            }
        }
    }

    /// Освобождает узел: плечи, сокет, память. Сигналинг к этому времени не запущен или остановлен.
    pub fn destroy(n: *Node) void {
        for (n.legs.items) |l| l.destroy(n.gpa);
        n.legs.deinit(n.gpa);
        n.by_addr.deinit(n.gpa);
        n.sock.close(n.io);
        n.gpa.destroy(n);
    }

    /// Убирает плечо из узла. `with_partner` — закрыть и парное: его браузеру больше не с кем говорить.
    fn unlink(n: *Node, l: *Leg, with_partner: bool) void {
        for (n.legs.items, 0..) |x, i| {
            if (x == l) {
                _ = n.legs.swapRemove(i);
                break;
            }
        }
        // Ни один адрес не должен больше вести к плечу, которого нет.
        while (true) {
            var stale: ?AddrKey = null;
            var it = n.by_addr.iterator();
            while (it.next()) |e| {
                if (e.value_ptr.* == l) {
                    stale = e.key_ptr.*;
                    break;
                }
            }
            _ = n.by_addr.remove(stale orelse break);
        }
        if (l.partner) |p| {
            p.partner = null;
            if (with_partner) p.kill("собеседник отключился");
        }
        l.destroy(n.gpa);
    }
};

/// Offer «другого браузера» для тестов: те же пять каналов, что у страницы, но свои номера
/// секций, типов нагрузки, расширений и потоков — как у Firefox рядом с Chrome.
const other_offer =
    "v=0\r\no=mozilla...THIS_IS_SDPARTA-99.0 7777 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n" ++
    "a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\n" ++
    "a=group:BUNDLE 5 6 7 8 9\r\na=ice-options:trickle\r\n" ++
    "m=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=ice-ufrag:ffuf\r\na=ice-pwd:ffpwdffpwdffpwdffpwdff\r\na=mid:5\r\na=sendrecv\r\na=rtcp-mux\r\n" ++
    "a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:mid\r\na=extmap:5 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\n" ++
    "a=rtpmap:109 opus/48000/2\r\na=ssrc:5001 cname:{ff}\r\n" ++
    "m=video 9 UDP/TLS/RTP/SAVPF 120 124\r\na=mid:6\r\na=sendrecv\r\na=rtcp-mux\r\n" ++
    "a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:mid\r\na=extmap:7 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\r\n" ++
    "a=rtpmap:120 VP8/90000\r\na=rtcp-fb:120 nack\r\na=rtcp-fb:120 nack pli\r\na=rtpmap:124 rtx/90000\r\na=fmtp:124 apt=120\r\n" ++
    "a=ssrc-group:FID 5002 5003\r\na=ssrc:5002 cname:{ff}\r\na=ssrc:5003 cname:{ff}\r\n" ++
    "m=video 9 UDP/TLS/RTP/SAVPF 120 124\r\na=mid:7\r\na=sendrecv\r\na=rtcp-mux\r\n" ++
    "a=rtpmap:120 VP8/90000\r\na=rtpmap:124 rtx/90000\r\na=fmtp:124 apt=120\r\na=ssrc-group:FID 5004 5005\r\na=ssrc:5004 cname:{ff}\r\na=ssrc:5005 cname:{ff}\r\n" ++
    "m=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=mid:8\r\na=sendrecv\r\na=rtcp-mux\r\na=rtpmap:109 opus/48000/2\r\na=ssrc:5006 cname:{ff}\r\n" ++
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:9\r\na=sctp-port:5000\r\na=max-message-size:1073741823\r\n";

const chrome_offer = @embedFile("testdata/chrome_157_offer.sdp");

/// Узел с двумя плечами для тестов: «браузеры» — два сокета на петле, вместо рукопожатия
/// DTLS плечам сразу даны ключи SRTP.
const TestPair = struct {
    n: *Node,
    a: *Leg,
    b: *Leg,
    sock_a: net.Socket,
    sock_b: net.Socket,
    /// Чем шлют браузеры и чем читают то, что прислал узел.
    a_tx: srtp.Context = undefined,
    a_rx: srtp.Context = undefined,
    b_tx: srtp.Context = undefined,
    b_rx: srtp.Context = undefined,
    buf: [datagram_max]u8 = undefined,

    const key_a_browser: [16]u8 = @splat(0xa1);
    const key_a_node: [16]u8 = @splat(0xa2);
    const key_b_browser: [16]u8 = @splat(0xb1);
    const key_b_node: [16]u8 = @splat(0xb2);
    const salt: [14]u8 = @splat(0x55);

    fn init(t: *TestPair, io: Io, profile: srtp.Profile) !void {
        const gpa = std.testing.allocator;
        const n = try Node.create(gpa, io, .{ .room = "test" });
        const loop = try net.IpAddress.parse("127.0.0.1", 0);
        t.* = .{ .n = n, .a = undefined, .b = undefined, .sock_a = try loop.bind(io, .{ .mode = .dgram }), .sock_b = try loop.bind(io, .{ .mode = .dgram }) };
        const oa = try sdp.parseOffer(chrome_offer);
        const ob = try sdp.parseOffer(other_offer);
        const id_a: Id = "aaaaaaaaaaaaaaaa".*;
        const id_b: Id = "bbbbbbbbbbbbbbbb".*;
        t.a = try Leg.create(gpa, io, n.host(), &n.identity, n.srtp_profiles, id_a, id_b, &oa, n.dual, 0);
        try n.legs.append(gpa, t.a);
        t.b = try Leg.create(gpa, io, n.host(), &n.identity, n.srtp_profiles, id_b, id_a, &ob, n.dual, 0);
        try n.legs.append(gpa, t.b);
        t.a.partner = t.b;
        t.b.partner = t.a;
        const s = salt[0..profile.saltLen()];
        inline for (.{ .{ t.a, t.sock_a, key_a_browser, key_a_node }, .{ t.b, t.sock_b, key_b_browser, key_b_node } }) |x| {
            const l: *Leg = x[0];
            l.srtp_in.init(profile, x[2], s);
            l.srtp_out.init(profile, x[3], s);
            l.media_ready = true;
            l.selected = x[1].address;
            n.bind(x[1].address, l);
        }
        t.a_tx.init(profile, key_a_browser, s);
        t.a_rx.init(profile, key_a_node, s);
        t.b_tx.init(profile, key_b_browser, s);
        t.b_rx.init(profile, key_b_node, s);
    }

    fn deinit(t: *TestPair) void {
        t.sock_a.close(t.n.io);
        t.sock_b.close(t.n.io);
        t.n.destroy();
    }

    /// Пакет от браузера плеча: защищает его ключами браузера и отдаёт узлу, как с сокета.
    fn feed(t: *TestPair, from_a: bool, packet: []const u8, is_rtcp: bool) !void {
        @memcpy(t.buf[0..packet.len], packet);
        const tx = if (from_a) &t.a_tx else &t.b_tx;
        const len = if (is_rtcp) try tx.protectRtcp(&t.buf, packet.len) else try tx.protectRtp(&t.buf, packet.len);
        const from = if (from_a) t.sock_a.address else t.sock_b.address;
        t.n.onDatagram(leg_mod.normalize(from), &t.buf, len);
    }

    /// Что узел прислал браузеру плеча: расшифрованный пакет или null, если не прислал ничего.
    fn take(t: *TestPair, at_a: bool, out: *[datagram_max]u8, is_rtcp: bool) !?[]u8 {
        const sock = if (at_a) &t.sock_a else &t.sock_b;
        const msg = sock.receiveTimeout(t.n.io, out, .{ .duration = .{ .raw = .fromMilliseconds(150), .clock = .awake } }) catch |e| switch (e) {
            error.Timeout => return null,
            else => return e,
        };
        const rx = if (at_a) &t.a_rx else &t.b_rx;
        return if (is_rtcp) try rx.unprotectRtcp(msg.data) else try rx.unprotectRtp(msg.data);
    }
};

fn testHex(comptime text: []const u8) [text.len / 2]u8 {
    var out: [text.len / 2]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, text) catch unreachable;
    return out;
}

test "node: RTP из одного плеча уходит в парное под его номерами" {
    var threaded: Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    inline for (.{ srtp.Profile.aes128_cm_sha1_80, srtp.Profile.aead_aes128_gcm }) |profile| {
        var t: TestPair = undefined;
        try t.init(threaded.io(), profile);
        defer t.deinit();
        var out: [datagram_max]u8 = undefined;
        const cam_b = &t.b.tracks[1];

        // Кадр камеры Chrome: тип 96 с маркером, поток 1666214973; расширения — MID «1» (номер 4),
        // transport-cc (номер 3) и поворот видео (номер 13).
        const cam_ssrc: u32 = 1666214973;
        var packet = testHex("90e0" ++ "1234" ++ "00015f90" ++ "00000000" ++ "bede0002" ++ "4031" ++ "31002a" ++ "d001" ++ "00" ++ "9d012a0102030405");
        std.mem.writeInt(u32, packet[8..12], cam_ssrc, .big);
        try t.feed(true, &packet, false);
        const got = (try t.take(false, &out, false)).?;
        // У второго браузера VP8 — тип 120, MID — номер 3 и секция «6», transport-cc — номер 7,
        // а поворота видео он не знает: место расширения затёрто. Остальное дошло как было.
        var want = testHex("90f8" ++ "1234" ++ "00015f90" ++ "00000000" ++ "bede0002" ++ "3036" ++ "71002a" ++ "0000" ++ "00" ++ "9d012a0102030405");
        std.mem.writeInt(u32, want[8..12], cam_b.local_ssrc, .big);
        try std.testing.expectEqualSlices(u8, &want, got);

        // Повтор (rtx) того же канала: тип 97 → 124, поток повторов → поток повторов узла.
        var rtx = testHex("8061" ++ "0007" ++ "00015f90" ++ "00000000" ++ "1234" ++ "9d012a");
        std.mem.writeInt(u32, rtx[8..12], 1458837552, .big);
        try t.feed(true, &rtx, false);
        const got_rtx = (try t.take(false, &out, false)).?;
        try std.testing.expectEqual(@as(u8, 124), got_rtx[1]);
        try std.testing.expectEqual(cam_b.local_rtx, std.mem.readInt(u32, got_rtx[8..12], .big));
        try std.testing.expectEqualSlices(u8, rtx[12..], got_rtx[12..]);

        // Звук в обратную сторону: Opus у второго браузера — тип 109, у Chrome — 111.
        var voice = testHex("806d" ++ "0100" ++ "000003c0" ++ "00000000" ++ "f8fffe");
        std.mem.writeInt(u32, voice[8..12], 5001, .big);
        try t.feed(false, &voice, false);
        const got_voice = (try t.take(true, &out, false)).?;
        try std.testing.expectEqual(@as(u8, 111), got_voice[1]);
        try std.testing.expectEqual(t.a.tracks[0].local_ssrc, std.mem.readInt(u32, got_voice[8..12], .big));

        // Чужой поток, чужой тип нагрузки, тот же пакет ещё раз и пакет с испорченной меткой
        // дальше не идут.
        var stranger = packet;
        std.mem.writeInt(u16, stranger[2..4], 0x1235, .big);
        std.mem.writeInt(u32, stranger[8..12], 42, .big);
        stranger[17] = 0x39; // MID «9» — секция канала данных, а не медиа
        try t.feed(true, &stranger, false);
        var odd = packet;
        std.mem.writeInt(u16, odd[2..4], 0x1236, .big);
        odd[1] = 0xe0 | 100;
        try t.feed(true, &odd, false);
        @memcpy(t.buf[0..packet.len], &packet);
        var replay: srtp.Context = undefined;
        replay.init(profile, TestPair.key_a_browser, TestPair.salt[0..profile.saltLen()]);
        var len = try replay.protectRtp(&t.buf, packet.len);
        t.n.onDatagram(leg_mod.normalize(t.sock_a.address), &t.buf, len);
        std.mem.writeInt(u16, packet[2..4], 0x1237, .big);
        @memcpy(t.buf[0..packet.len], &packet);
        len = try t.a_tx.protectRtp(&t.buf, packet.len);
        t.buf[len - 1] ^= 1;
        t.n.onDatagram(leg_mod.normalize(t.sock_a.address), &t.buf, len);
        try std.testing.expectEqual(@as(?[]u8, null), try t.take(false, &out, false));
        try std.testing.expectEqual(@as(u64, 2), t.a.stats.unknown);
        try std.testing.expectEqual(@as(u64, 2), t.a.stats.rejected);
        try std.testing.expectEqual(@as(u64, 3), t.n.totals.rtp);

        // Пока парное плечо без ключей, пакетам идти некуда.
        t.b.media_ready = false;
        std.mem.writeInt(u16, packet[2..4], 0x1238, .big);
        try t.feed(true, &packet, false);
        try std.testing.expectEqual(@as(?[]u8, null), try t.take(false, &out, false));
        try std.testing.expectEqual(@as(u64, 1), t.n.totals.unpaired);
    }
}

test "node: RTCP переводится между плечами, узел сам просит ключевой кадр" {
    var threaded: Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    var t: TestPair = undefined;
    try t.init(threaded.io(), .aes128_cm_sha1_80);
    defer t.deinit();
    var out: [datagram_max]u8 = undefined;
    const cam_a = &t.a.tracks[1];
    const cam_b = &t.b.tracks[1];

    // Второй браузер просит ключевой кадр камеры: о потоке он знает под номером узла на своём
    // плече, а до Chrome просьба должна дойти с номером его собственного потока.
    var pli: [rtcp.pli_len]u8 = undefined;
    _ = rtcp.writePli(&pli, 5002, cam_b.local_ssrc);
    try t.feed(false, &pli, true);
    const got = (try t.take(true, &out, true)).?;
    var want: [rtcp.pli_len]u8 = undefined;
    _ = rtcp.writePli(&want, cam_a.local_ssrc, 1666214973);
    try std.testing.expectEqualSlices(u8, &want, got);
    try std.testing.expectEqual(@as(u64, 1), t.n.totals.pli);

    // FIR от того же браузера: поток назван в записи запроса.
    var fir: [rtcp.fir_len]u8 = undefined;
    _ = rtcp.writeFir(&fir, 5002, cam_b.local_ssrc, 3);
    try t.feed(false, &fir, true);
    const got_fir = (try t.take(true, &out, true)).?;
    var want_fir: [rtcp.fir_len]u8 = undefined;
    _ = rtcp.writeFir(&want_fir, cam_a.local_ssrc, 1666214973, 3);
    try std.testing.expectEqualSlices(u8, &want_fir, got_fir);
    try std.testing.expectEqual(@as(u64, 1), t.n.totals.fir);

    // Узел сам просит ключевой кадр: у Chrome — через PLI в обоих видеоканалах; у второго
    // браузера в канале экрана о PLI не договорились, а FIR он не предлагал — там узел молчит.
    t.n.askKeyframes(t.a);
    for ([_]usize{ 1, 2 }) |i| {
        const asked = (try t.take(true, &out, true)).?;
        _ = rtcp.writePli(&want, t.a.tracks[i].local_ssrc, t.a.tracks[i].remote_ssrc);
        try std.testing.expectEqualSlices(u8, &want, asked);
    }
    t.n.askKeyframes(t.b);
    const asked_b = (try t.take(false, &out, true)).?;
    _ = rtcp.writePli(&want, cam_b.local_ssrc, 5002);
    try std.testing.expectEqualSlices(u8, &want, asked_b);
    try std.testing.expectEqual(@as(?[]u8, null), try t.take(false, &out, true));
    try std.testing.expectEqual(@as(u64, 3), t.n.totals.own_pli);
}

// С проверенного адреса может прийти что угодно: STUN, DTLS, медиа или просто мусор.
test "node: случайные датаграммы узел не роняют" {
    var threaded: Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    var t: TestPair = undefined;
    try t.init(io, .aead_aes128_gcm);
    defer t.deinit();
    var prng: std.Random.DefaultPrng = .init(0x4e4f4445);
    const rnd = prng.random();
    const from = leg_mod.normalize(t.sock_a.address);
    for (0..20000) |i| {
        // Сорванное рукопожатие плечо больше не слушает: время от времени начинаем его заново.
        if (i % 64 == 0) {
            t.a.tls.init(io, &t.n.identity, @splat(0), t.n.srtp_profiles);
            t.a.assoc.init(io);
        }
        const len = 1 + rnd.uintLessThan(usize, 400);
        const d = t.buf[0..len];
        rnd.bytes(d);
        switch (i % 4) {
            0 => if (len >= 20) {
                // Похоже на STUN: вид сообщения, длина и «волшебное число».
                d[0] = rnd.uintLessThan(u8, 2);
                d[1] = if (rnd.boolean()) 0x01 else d[1];
                std.mem.writeInt(u16, d[2..4], @intCast(@min(len - 20, 0xffff) & ~@as(usize, 3)), .big);
                std.mem.writeInt(u32, d[4..8], stun.magic_cookie, .big);
            },
            1 => if (len >= 13) {
                // Похоже на запись DTLS: вид, версия, эпоха 0 или 1, длина по размеру датаграммы.
                d[0] = 20 + rnd.uintLessThan(u8, 4);
                d[1] = 0xfe;
                d[2] = 0xfd;
                std.mem.writeInt(u16, d[3..5], rnd.uintLessThan(u16, 2), .big);
                std.mem.writeInt(u16, d[11..13], @intCast(len - 13), .big);
                if (d[0] == 22 and len >= 25) d[13] = ([_]u8{ 1, 11, 15, 16, 20 })[rnd.uintLessThan(usize, 5)];
            },
            2 => d[0] = 0x80 | (d[0] & 0x3f),
            else => {
                d[0] = 0x80 | (d[0] & 0x1f);
                if (len >= 2) d[1] = 200 + (d[1] % 8);
            },
        }
        t.n.onDatagram(from, &t.buf, len);
        // Таймеры — только сразу после нового рукопожатия: закрытое плечо узел убрал бы совсем.
        if (i % 640 == 0) t.n.timers(i * 1000);
    }
    try std.testing.expectEqual(@as(usize, 2), t.n.legs.items.len);
    try std.testing.expect(t.a.stats.rejected > 5000);
    try std.testing.expectEqual(@as(u64, 0), t.n.totals.rtp);
}

pub fn writeJsonString(w: *std.Io.Writer, s: []const u8) std.Io.Writer.Error!void {
    try w.writeByte('"');
    for (s) |c| switch (c) {
        '"' => try w.writeAll("\\\""),
        '\\' => try w.writeAll("\\\\"),
        '\n' => try w.writeAll("\\n"),
        '\r' => try w.writeAll("\\r"),
        '\t' => try w.writeAll("\\t"),
        0...8, 11, 12, 14...0x1f => try w.print("\\u{x:0>4}", .{c}),
        else => try w.writeByte(c),
    };
    try w.writeByte('"');
}

test "node: строка JSON и разбор сообщения комнаты" {
    var buf: [256]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try writeJsonString(&w, "v=0\r\na=mid:\"0\"\t\\ Узел \x01");
    try std.testing.expectEqualStrings("\"v=0\\r\\na=mid:\\\"0\\\"\\t\\\\ Узел \\u0001\"", w.buffered());

    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const text =
        \\{"v":1,"f":"00aa11bb22cc33dd","n":7,"t":"desc","to":"ffffffffffffffff","peer":"0123456789abcdef","hue":120,
        \\ "d":{"type":"offer","sdp":"v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n"}}
    ;
    const m = try std.json.parseFromSliceLeaky(Msg, arena.allocator(), text, .{ .ignore_unknown_fields = true });
    try std.testing.expectEqual(@as(u64, 7), m.n);
    try std.testing.expect(validId(m.f) and validId(m.peer));
    try std.testing.expectEqualStrings("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n", m.d.?.sdp);
    const cands = try std.json.parseFromSliceLeaky(Msg, arena.allocator(),
        \\{"v":1,"f":"00aa11bb22cc33dd","n":1099511627776,"t":"cand","peer":"0123456789abcdef","c":[{"candidate":"candidate:1 1 udp 1 203.0.113.5 5000 typ host","sdpMid":"0","sdpMLineIndex":0},{"sdpMid":null}]}
    , .{ .ignore_unknown_fields = true });
    try std.testing.expectEqual(@as(usize, 2), cands.c.?.len);
    try std.testing.expectEqual(@as(u64, 1 << 40), cands.n);
    try std.testing.expect(sdp.parseCandidate(cands.c.?[0].candidate) != null);
    // Номер не целым числом, не тот тип поля: сообщение не разбирается и будет отброшено.
    try std.testing.expect(if (std.json.parseFromSliceLeaky(Msg, arena.allocator(), "{\"v\":1,\"n\":-1}", .{ .ignore_unknown_fields = true })) |_| false else |_| true);
    try std.testing.expect(if (std.json.parseFromSliceLeaky(Msg, arena.allocator(), "{\"v\":1,\"f\":5}", .{ .ignore_unknown_fields = true })) |_| false else |_| true);
    try std.testing.expect(!validId("00AA11BB22CC33DD"));
    try std.testing.expect(!validId("00aa11bb22cc33d"));
}

test "node: имя участника для журнала" {
    var p: Person = .{};
    p.rename("Аня");
    try std.testing.expectEqualStrings("Аня", p.name());
    p.rename("Бо\x07рис\n");
    try std.testing.expectEqualStrings("Борис", p.name());
    // Пустое и испорченное имя прежнего не стирают; длинное обрезается по целому знаку.
    p.rename("");
    p.rename("\xff\xfe");
    try std.testing.expectEqualStrings("Борис", p.name());
    var long: [200]u8 = undefined;
    for (0..100) |i| @memcpy(long[i * 2 ..][0..2], "я");
    p.rename(&long);
    try std.testing.expectEqual(@as(usize, 80), p.name().len);
    try std.testing.expect(std.unicode.utf8ValidateSlice(p.name()));
}

test "node: ключ адреса один для IPv4 и его отображения в IPv6" {
    const a = try net.IpAddress.parse("203.0.113.5", 5000);
    const b = leg_mod.mapped(a.ip4);
    try std.testing.expectEqual(addrKey(a), addrKey(b));
    const c = try net.IpAddress.parse("203.0.113.5", 5001);
    try std.testing.expect(!std.mem.eql(u8, &addrKey(a), &addrKey(c)));
    const v6 = try net.IpAddress.parse("2001:db8::1", 5000);
    try std.testing.expect(!std.mem.eql(u8, &addrKey(a), &addrKey(v6)));
}
