//! SCTP поверх DTLS (RFC 8261) для канала данных WebRTC: одна ассоциация, которую начинает
//! браузер. RFC 4960 в объёме, нужном каналу данных, — DATA, SACK, повторы (T3-rtx и быстрый
//! повтор), управление перегрузкой (медленный старт, избегание перегрузки, быстрое
//! восстановление), heartbeat, завершение — и рукопожатие DCEP (RFC 8832) для каналов, не
//! согласованных заранее. Частичной надёжности, перенастройки потоков и I-DATA нет: о них
//! узел не объявляет.
//! Чистая логика: на входе пакеты, на выходе пакеты и сообщения через Sink; время даёт вызывающий.
const std = @import("std");
const Crc32c = std.hash.crc.@"CRC-32/ISCSI";

/// Пакет SCTP должен уместиться в одну запись DTLS и одну датаграмму.
pub const max_packet = 1160;
/// Данные одного блока DATA: в том же пакете остаётся место для SACK.
pub const max_chunk_data = 1100;
const send_slots = 64;
const recv_slots = 64;
const max_message = 64 * 1024;
const mtu_bytes: u32 = max_packet;

pub const ppid_dcep: u32 = 50;
pub const ppid_string: u32 = 51;
pub const ppid_binary: u32 = 53;
pub const ppid_string_empty: u32 = 56;
pub const ppid_binary_empty: u32 = 57;

const chunk_data: u8 = 0;
const chunk_init: u8 = 1;
const chunk_init_ack: u8 = 2;
const chunk_sack: u8 = 3;
const chunk_heartbeat: u8 = 4;
const chunk_heartbeat_ack: u8 = 5;
const chunk_abort: u8 = 6;
const chunk_shutdown: u8 = 7;
const chunk_shutdown_ack: u8 = 8;
const chunk_cookie_echo: u8 = 10;
const chunk_cookie_ack: u8 = 11;
const chunk_shutdown_complete: u8 = 14;

const flag_end: u8 = 1;
const flag_begin: u8 = 2;
const flag_unordered: u8 = 4;
const flag_immediate: u8 = 8;

const rto_initial_us: u64 = 1_000_000;
const rto_min_us: u64 = 250_000;
const rto_max_us: u64 = 3_000_000;

pub const Sink = struct {
    ctx: *anyopaque,
    /// Пакет SCTP для собеседника.
    send: *const fn (ctx: *anyopaque, packet: []const u8) void,
    /// Целое сообщение от собеседника.
    message: *const fn (ctx: *anyopaque, sid: u16, ppid: u32, data: []const u8) void,
};

pub const State = enum { listen, established, closed };

/// Сравнение номеров TSN по кругу (RFC 1982): a < b.
fn before(a: u32, b: u32) bool {
    return @as(i32, @bitCast(a -% b)) < 0;
}

pub fn checksum(packet: []const u8) u32 {
    var c = Crc32c.init();
    c.update(packet[0..8]);
    c.update(&.{ 0, 0, 0, 0 });
    c.update(packet[12..]);
    return c.final();
}

const SendSlot = struct {
    tsn: u32 = 0,
    len: u16 = 0,
    flags: u8 = 0,
    sid: u16 = 0,
    ssn: u16 = 0,
    ppid: u32 = 0,
    sent_us: u64 = 0,
    sent: bool = false,
    acked: bool = false,
    retransmitted: bool = false,
    /// Потерян: уйдёт снова раньше новых данных.
    lost: bool = false,
    misses: u8 = 0,
    data: [max_chunk_data]u8 = undefined,
};

const RecvSlot = struct {
    used: bool = false,
    tsn: u32 = 0,
    flags: u8 = 0,
    sid: u16 = 0,
    ppid: u32 = 0,
    len: u16 = 0,
    /// Собеседник режет блоки по своему MTU (Chrome — до 1163 байт): место под любую датаграмму.
    data: [1500]u8 = undefined,
};

/// Сборщик пакета: общий заголовок, блоки, контрольная сумма.
const Packet = struct {
    buf: [max_packet]u8 = undefined,
    len: usize = 12,

    fn init(src: u16, dst: u16, tag: u32) Packet {
        var p: Packet = .{};
        std.mem.writeInt(u16, p.buf[0..2], src, .big);
        std.mem.writeInt(u16, p.buf[2..4], dst, .big);
        std.mem.writeInt(u32, p.buf[4..8], tag, .big);
        return p;
    }

    fn room(p: *const Packet) usize {
        return max_packet - p.len;
    }

    /// Начинает блок; вызывающий пишет `value_len` байт в возвращённый срез.
    fn chunk(p: *Packet, t: u8, flags: u8, value_len: usize) []u8 {
        const padded = (value_len + 3) & ~@as(usize, 3);
        std.debug.assert(p.len + 4 + padded <= max_packet);
        p.buf[p.len] = t;
        p.buf[p.len + 1] = flags;
        std.mem.writeInt(u16, p.buf[p.len + 2 ..][0..2], @intCast(4 + value_len), .big);
        const v = p.buf[p.len + 4 ..][0..value_len];
        @memset(p.buf[p.len + 4 + value_len ..][0 .. padded - value_len], 0);
        p.len += 4 + padded;
        return v;
    }

    fn finish(p: *Packet) []const u8 {
        std.mem.writeInt(u32, p.buf[8..12], checksum(p.buf[0..p.len]), .little);
        return p.buf[0..p.len];
    }
};

pub const Association = struct {
    state: State = .listen,
    local_port: u16 = 5000,
    peer_port: u16 = 5000,
    my_tag: u32,
    peer_tag: u32 = 0,
    cookie: [16]u8,
    my_initial_tsn: u32,
    peer_streams_in: u16 = 0,

    // Приём.
    peer_cum_tsn: u32 = 0,
    /// Большие буферы не заполняются, пока не понадобятся; `init` сбрасывает только флаги `used`.
    recv: [recv_slots]RecvSlot = undefined,
    msg: [max_message]u8 = undefined,
    msg_len: usize = 0,
    msg_discard: bool = false,
    dups: [4]u32 = undefined,
    dup_count: usize = 0,
    need_sack: bool = false,

    // Отправка.
    /// Ячейку пишет queueMessage — раньше, чем её кто-либо прочтёт.
    slots: [send_slots]SendSlot = undefined,
    next_tsn: u32,
    /// Всё по этот TSN включительно подтверждено.
    cum_ack: u32,
    /// Следующий TSN, который ещё ни разу не уходил.
    sent_next: u32,
    ssn: [8]struct { sid: u16, next: u16 } = undefined,
    ssn_count: usize = 0,
    cwnd: u32 = 10 * mtu_bytes,
    ssthresh: u32 = 1 << 30,
    partial_acked: u32 = 0,
    flight: u32 = 0,
    peer_rwnd: u32 = 128 * 1024,
    srtt_us: u64 = 0,
    rttvar_us: u64 = 0,
    rto_us: u64 = rto_initial_us,
    t3_at_us: u64 = 0, // 0 — таймер не идёт
    fast_recovery: bool = false,
    recovery_exit: u32 = 0,
    has_lost: bool = false,
    /// Собеседник подтвердил данные: в очереди отправки освободилось место.
    freed: bool = false,

    /// Настраивает ассоциацию на месте: для стека потока она слишком велика.
    pub fn init(a: *Association, io: std.Io) void {
        var r: [24]u8 = undefined;
        io.random(&r);
        var tag = std.mem.readInt(u32, r[0..4], .little);
        if (tag == 0) tag = 1;
        const tsn = std.mem.readInt(u32, r[4..8], .little);
        a.* = .{ .my_tag = tag, .cookie = r[8..24].*, .my_initial_tsn = tsn, .next_tsn = tsn, .cum_ack = tsn -% 1, .sent_next = tsn };
        for (&a.recv) |*slot_| slot_.used = false;
    }

    /// Занятые ячейки: отправлено и не подтверждено или ещё не отправлено.
    pub fn usedSlots(a: *const Association) usize {
        return a.next_tsn -% a.cum_ack -% 1;
    }

    pub fn freeSlots(a: *const Association) usize {
        return send_slots - a.usedSlots();
    }

    pub fn slotsFor(len: usize) usize {
        return @max(1, (len + max_chunk_data - 1) / max_chunk_data);
    }

    // ------------------------------------------------------------------ вход

    pub fn handlePacket(a: *Association, pkt: []const u8, now_us: u64, sink: Sink) void {
        if (pkt.len < 12 or a.state == .closed) return;
        if (std.mem.readInt(u32, pkt[8..12], .little) != checksum(pkt)) return;
        const tag = std.mem.readInt(u32, pkt[4..8], .big);
        var pos: usize = 12;
        var got_data = false;
        var got_sack = false;
        while (pos + 4 <= pkt.len) {
            const t = pkt[pos];
            const flags = pkt[pos + 1];
            const len = std.mem.readInt(u16, pkt[pos + 2 ..][0..2], .big);
            if (len < 4 or pos + len > pkt.len) break;
            const v = pkt[pos + 4 .. pos + len];
            pos += (len + 3) & ~@as(usize, 3);
            if (t == chunk_init) {
                if (tag == 0) a.onInit(pkt, v, sink);
                return; // INIT в пакете всегда один
            }
            if (tag != a.my_tag) {
                if (t == chunk_abort and flags & 1 != 0 and tag == a.peer_tag) a.state = .closed;
                return;
            }
            switch (t) {
                chunk_cookie_echo => a.onCookieEcho(v, sink),
                chunk_data => if (a.state == .established) {
                    a.onData(flags, v, sink);
                    got_data = true;
                },
                chunk_sack => if (a.state == .established) {
                    a.onSack(v, now_us);
                    got_sack = true;
                },
                chunk_heartbeat => {
                    if (v.len > max_packet - 16) continue; // в один пакет эхо не поместится
                    var p = Packet.init(a.local_port, a.peer_port, a.peer_tag);
                    @memcpy(p.chunk(chunk_heartbeat_ack, 0, v.len), v);
                    sink.send(sink.ctx, p.finish());
                },
                chunk_abort => {
                    a.state = .closed;
                    return;
                },
                chunk_shutdown => {
                    var p = Packet.init(a.local_port, a.peer_port, a.peer_tag);
                    _ = p.chunk(chunk_shutdown_ack, 0, 0);
                    sink.send(sink.ctx, p.finish());
                    a.state = .closed;
                    return;
                },
                chunk_shutdown_complete => {
                    a.state = .closed;
                    return;
                },
                else => {}, // незнакомые блоки пропускаем (о расширениях узел не объявляет)
            }
        }
        if (got_data) a.need_sack = true;
        if (got_sack or got_data) a.flush(now_us, sink);
        if (a.need_sack) a.sendSack(sink);
    }

    fn onInit(a: *Association, pkt: []const u8, v: []const u8, sink: Sink) void {
        if (v.len < 16 or a.state == .established) return;
        const peer_tag = std.mem.readInt(u32, v[0..4], .big);
        if (peer_tag == 0) return;
        a.peer_tag = peer_tag;
        a.peer_rwnd = std.mem.readInt(u32, v[4..8], .big);
        const peer_os = std.mem.readInt(u16, v[8..10], .big);
        const peer_mis = std.mem.readInt(u16, v[10..12], .big);
        a.peer_cum_tsn = std.mem.readInt(u32, v[12..16], .big) -% 1;
        a.peer_port = std.mem.readInt(u16, pkt[0..2], .big);
        a.local_port = std.mem.readInt(u16, pkt[2..4], .big);
        a.peer_streams_in = peer_mis;
        var p = Packet.init(a.local_port, a.peer_port, a.peer_tag);
        const ack = p.chunk(chunk_init_ack, 0, 16 + 4 + a.cookie.len);
        std.mem.writeInt(u32, ack[0..4], a.my_tag, .big);
        std.mem.writeInt(u32, ack[4..8], recv_slots * max_chunk_data, .big);
        std.mem.writeInt(u16, ack[8..10], @min(peer_mis, 1024), .big); // исходящие потоки
        std.mem.writeInt(u16, ack[10..12], @min(peer_os, 1024), .big); // входящие потоки
        std.mem.writeInt(u32, ack[12..16], a.my_initial_tsn, .big);
        std.mem.writeInt(u16, ack[16..18], 7, .big); // параметр State Cookie
        std.mem.writeInt(u16, ack[18..20], @intCast(4 + a.cookie.len), .big);
        @memcpy(ack[20..][0..a.cookie.len], &a.cookie);
        sink.send(sink.ctx, p.finish());
    }

    fn onCookieEcho(a: *Association, v: []const u8, sink: Sink) void {
        if (v.len != a.cookie.len or !std.mem.eql(u8, v, &a.cookie)) return;
        a.state = .established;
        var p = Packet.init(a.local_port, a.peer_port, a.peer_tag);
        _ = p.chunk(chunk_cookie_ack, 0, 0);
        sink.send(sink.ctx, p.finish());
    }

    fn onData(a: *Association, flags: u8, v: []const u8, sink: Sink) void {
        if (v.len < 12) return;
        const tsn = std.mem.readInt(u32, v[0..4], .big);
        const payload = v[12..];
        const ahead = tsn -% a.peer_cum_tsn;
        if (ahead == 0 or ahead > 0x8000_0000) {
            if (a.dup_count < a.dups.len) {
                a.dups[a.dup_count] = tsn;
                a.dup_count += 1;
            }
            return;
        }
        if (ahead > recv_slots or payload.len > a.recv[0].data.len) return; // места нет: собеседник пришлёт ещё раз
        const rs = &a.recv[tsn % recv_slots];
        if (rs.used and rs.tsn == tsn) return;
        rs.* = .{ .used = true, .tsn = tsn, .flags = flags, .sid = std.mem.readInt(u16, v[4..6], .big), .ppid = std.mem.readInt(u32, v[8..12], .big), .len = @intCast(payload.len) };
        @memcpy(rs.data[0..payload.len], payload);
        // Отдаём всё, что теперь идёт по порядку.
        while (true) {
            const next = &a.recv[(a.peer_cum_tsn +% 1) % recv_slots];
            if (!next.used or next.tsn != a.peer_cum_tsn +% 1) break;
            a.peer_cum_tsn +%= 1;
            next.used = false;
            a.reassemble(next, sink);
        }
    }

    fn reassemble(a: *Association, c: *const RecvSlot, sink: Sink) void {
        if (c.flags & flag_begin != 0) {
            a.msg_len = 0;
            a.msg_discard = false;
        }
        if (!a.msg_discard) {
            if (a.msg_len + c.len > a.msg.len) {
                a.msg_discard = true; // больше, чем берём: выбрасывается целиком
            } else {
                @memcpy(a.msg[a.msg_len..][0..c.len], c.data[0..c.len]);
                a.msg_len += c.len;
            }
        }
        if (c.flags & flag_end == 0) return;
        if (a.msg_discard) return;
        const data = a.msg[0..a.msg_len];
        if (c.ppid == ppid_dcep) return a.onDcep(c.sid, data, sink);
        const empty = c.ppid == ppid_string_empty or c.ppid == ppid_binary_empty;
        const ppid: u32 = if (c.ppid == ppid_string_empty) ppid_string else if (c.ppid == ppid_binary_empty) ppid_binary else c.ppid;
        sink.message(sink.ctx, c.sid, ppid, if (empty) data[0..0] else data);
    }

    /// На DATA_CHANNEL_OPEN отвечаем DATA_CHANNEL_ACK в том же потоке.
    fn onDcep(a: *Association, sid: u16, data: []const u8, sink: Sink) void {
        if (data.len == 0 or data[0] != 0x03) return;
        a.queueMessage(sid, ppid_dcep, &.{0x02}) catch {};
        _ = sink;
    }

    fn sendSack(a: *Association, sink: Sink) void {
        var p = Packet.init(a.local_port, a.peer_port, a.peer_tag);
        a.addSack(&p);
        sink.send(sink.ctx, p.finish());
    }

    fn sackLen(a: *const Association) usize {
        var gaps: usize = 0;
        var in_gap = false;
        for (1..recv_slots + 1) |i| {
            const tsn = a.peer_cum_tsn +% @as(u32, @intCast(i));
            const s = &a.recv[tsn % recv_slots];
            const have = s.used and s.tsn == tsn;
            if (have and !in_gap) gaps += 1;
            in_gap = have;
        }
        return 12 + gaps * 4 + a.dup_count * 4;
    }

    fn addSack(a: *Association, p: *Packet) void {
        var blocks: [recv_slots / 2 + 1][2]u16 = undefined;
        var n: usize = 0;
        var in_gap = false;
        for (1..recv_slots + 1) |i| {
            const tsn = a.peer_cum_tsn +% @as(u32, @intCast(i));
            const s = &a.recv[tsn % recv_slots];
            const have = s.used and s.tsn == tsn;
            if (have and !in_gap) {
                blocks[n] = .{ @intCast(i), @intCast(i) };
                n += 1;
            } else if (have) blocks[n - 1][1] = @intCast(i);
            in_gap = have;
        }
        const v = p.chunk(chunk_sack, 0, 12 + n * 4 + a.dup_count * 4);
        std.mem.writeInt(u32, v[0..4], a.peer_cum_tsn, .big);
        std.mem.writeInt(u32, v[4..8], recv_slots * max_chunk_data, .big);
        std.mem.writeInt(u16, v[8..10], @intCast(n), .big);
        std.mem.writeInt(u16, v[10..12], @intCast(a.dup_count), .big);
        for (blocks[0..n], 0..) |b, i| {
            std.mem.writeInt(u16, v[12 + i * 4 ..][0..2], b[0], .big);
            std.mem.writeInt(u16, v[14 + i * 4 ..][0..2], b[1], .big);
        }
        for (a.dups[0..a.dup_count], 0..) |d, i| std.mem.writeInt(u32, v[12 + n * 4 + i * 4 ..][0..4], d, .big);
        a.dup_count = 0;
        a.need_sack = false;
    }

    fn slot(a: *Association, tsn: u32) *SendSlot {
        return &a.slots[tsn % send_slots];
    }

    fn onSack(a: *Association, v: []const u8, now_us: u64) void {
        if (v.len < 12) return;
        const cum = std.mem.readInt(u32, v[0..4], .big);
        const a_rwnd = std.mem.readInt(u32, v[4..8], .big);
        const gap_count = std.mem.readInt(u16, v[8..10], .big);
        if (before(cum, a.cum_ack)) return; // старый SACK
        if (!before(cum, a.sent_next)) return; // подтверждает то, что не отправлялось
        if (12 + @as(usize, gap_count) * 4 > v.len) return;
        const flight_before = a.flight;
        var acked_bytes: u32 = 0;
        var rtt_sample: ?u64 = null;
        const cum_advanced = before(a.cum_ack, cum);

        // Подтверждение подряд.
        while (before(a.cum_ack, cum)) {
            a.cum_ack +%= 1;
            const s = a.slot(a.cum_ack);
            if (!s.acked) {
                acked_bytes += s.len;
                if (!s.lost) a.flight -|= s.len;
                if (!s.retransmitted) rtt_sample = now_us -| s.sent_us;
            }
            s.* = .{ .data = undefined };
            a.freed = true;
        }
        // Блоки с пропусками: подтверждено не по порядку.
        var highest_new: ?u32 = null;
        for (0..gap_count) |i| {
            const start = std.mem.readInt(u16, v[12 + i * 4 ..][0..2], .big);
            const end = std.mem.readInt(u16, v[14 + i * 4 ..][0..2], .big);
            if (start == 0 or end < start) continue;
            var off: u32 = start;
            while (off <= end) : (off += 1) {
                const tsn = cum +% off;
                if (!before(tsn, a.sent_next)) break;
                const s = a.slot(tsn);
                if (s.acked or !s.sent) continue;
                s.acked = true;
                acked_bytes += s.len;
                if (!s.lost) a.flight -|= s.len;
                s.lost = false;
                if (!s.retransmitted) rtt_sample = now_us -| s.sent_us;
                highest_new = tsn;
            }
        }
        // Отметки о пропуске для блоков ниже старшего из только что подтверждённых (RFC 4960, раздел 7.2.4).
        var enter_recovery = false;
        if (highest_new) |h| {
            var tsn = a.cum_ack +% 1;
            while (before(tsn, h)) : (tsn +%= 1) {
                const s = a.slot(tsn);
                if (s.acked or !s.sent or s.lost) continue;
                s.misses += 1;
                if (s.misses >= 3) {
                    s.lost = true;
                    s.misses = 0;
                    a.flight -|= s.len;
                    a.has_lost = true;
                    enter_recovery = true;
                }
            }
        }
        if (rtt_sample) |r| a.updateRto(r);

        if (a.fast_recovery and !before(a.cum_ack, a.recovery_exit)) a.fast_recovery = false;
        if (enter_recovery and !a.fast_recovery) {
            a.ssthresh = @max(a.cwnd / 2, 4 * mtu_bytes);
            a.cwnd = a.ssthresh;
            a.partial_acked = 0;
            a.fast_recovery = true;
            a.recovery_exit = a.sent_next -% 1;
        } else if (cum_advanced and !a.fast_recovery and flight_before + acked_bytes >= a.cwnd) {
            // Окно растёт, только если им пользовались.
            if (a.cwnd <= a.ssthresh) {
                a.cwnd += @min(acked_bytes, 2 * mtu_bytes);
            } else {
                a.partial_acked += acked_bytes;
                if (a.partial_acked >= a.cwnd) {
                    a.partial_acked -= a.cwnd;
                    a.cwnd += mtu_bytes;
                }
            }
        }
        if (a.flight == 0) a.partial_acked = 0;
        a.peer_rwnd = a_rwnd -| a.flight;
        // T3-rtx: заново, когда подтверждены самые ранние данные; стоп, когда в пути ничего нет.
        if (a.flight == 0 and !a.has_lost) {
            a.t3_at_us = 0;
        } else if (cum_advanced or a.t3_at_us == 0) {
            a.t3_at_us = now_us + a.rto_us;
        }
    }

    fn updateRto(a: *Association, r: u64) void {
        if (a.srtt_us == 0) {
            a.srtt_us = r;
            a.rttvar_us = r / 2;
        } else {
            const diff = if (a.srtt_us > r) a.srtt_us - r else r - a.srtt_us;
            a.rttvar_us = (3 * a.rttvar_us + diff) / 4;
            a.srtt_us = (7 * a.srtt_us + r) / 8;
        }
        a.rto_us = std.math.clamp(a.srtt_us + 4 * a.rttvar_us, rto_min_us, rto_max_us);
    }

    // ------------------------------------------------------------------ выход

    /// Ставит сообщение в очередь, разрезав на блоки DATA. Места нет — ошибка: решает вызывающий.
    pub fn queueMessage(a: *Association, sid: u16, ppid: u32, data: []const u8) error{ Full, Closed }!void {
        if (a.state != .established) return error.Closed;
        const n = slotsFor(data.len);
        if (n > a.freeSlots()) return error.Full;
        const ssn = a.nextSsn(sid);
        var off: usize = 0;
        for (0..n) |i| {
            const take = @min(max_chunk_data, data.len - off);
            const s = a.slot(a.next_tsn);
            s.* = .{ .tsn = a.next_tsn, .len = @intCast(take), .sid = sid, .ssn = ssn, .ppid = ppid };
            if (i == 0) s.flags |= flag_begin;
            if (i == n - 1) s.flags |= flag_end;
            @memcpy(s.data[0..take], data[off..][0..take]);
            off += take;
            a.next_tsn +%= 1;
        }
    }

    fn nextSsn(a: *Association, sid: u16) u16 {
        for (a.ssn[0..a.ssn_count]) |*e| {
            if (e.sid == sid) {
                defer e.next +%= 1;
                return e.next;
            }
        }
        if (a.ssn_count < a.ssn.len) {
            a.ssn[a.ssn_count] = .{ .sid = sid, .next = 1 };
            a.ssn_count += 1;
        }
        return 0;
    }

    fn addData(a: *Association, p: *Packet, s: *SendSlot, immediate: bool) void {
        const v = p.chunk(chunk_data, s.flags | @as(u8, if (immediate) flag_immediate else 0), 12 + s.len);
        std.mem.writeInt(u32, v[0..4], s.tsn, .big);
        std.mem.writeInt(u16, v[4..6], s.sid, .big);
        std.mem.writeInt(u16, v[6..8], s.ssn, .big);
        std.mem.writeInt(u32, v[8..12], s.ppid, .big);
        @memcpy(v[12..][0..s.len], s.data[0..s.len]);
        _ = a;
    }

    /// Шлёт, сколько позволяют окна перегрузки и приёма: сначала потерянные блоки, потом новые.
    pub fn flush(a: *Association, now_us: u64, sink: Sink) void {
        if (a.state != .established) return;
        var first = true;
        while (true) {
            var p = Packet.init(a.local_port, a.peer_port, a.peer_tag);
            if (a.need_sack and a.sackLen() + 4 + 12 + max_chunk_data <= p.room()) a.addSack(&p);
            const s = a.nextToSend(first) orelse {
                if (p.len > 12) sink.send(sink.ctx, p.finish());
                return;
            };
            first = false;
            const was_lost = s.lost;
            if (was_lost) {
                s.lost = false;
                s.retransmitted = true;
                a.has_lost = a.anyLost();
            } else {
                s.sent = true;
                a.sent_next = s.tsn +% 1;
            }
            s.sent_us = now_us;
            a.flight += s.len;
            a.peer_rwnd -|= s.len;
            // Просим SACK сразу, если окно заполнено или слать больше нечего.
            const last = a.flight + max_chunk_data > a.cwnd or a.sent_next == a.next_tsn;
            a.addData(&p, s, last);
            sink.send(sink.ctx, p.finish());
            if (a.t3_at_us == 0) a.t3_at_us = now_us + a.rto_us;
        }
    }

    fn anyLost(a: *Association) bool {
        var tsn = a.cum_ack +% 1;
        while (before(tsn, a.sent_next)) : (tsn +%= 1) {
            if (a.slot(tsn).lost) return true;
        }
        return false;
    }

    fn nextToSend(a: *Association, first: bool) ?*SendSlot {
        if (a.has_lost) {
            var tsn = a.cum_ack +% 1;
            while (before(tsn, a.sent_next)) : (tsn +%= 1) {
                const s = a.slot(tsn);
                if (!s.lost) continue;
                // Первый повтор уходит и при заполненном окне (RFC 4960, раздел 7.2.4).
                if (first or a.flight + s.len <= a.cwnd) return s;
                return null;
            }
            a.has_lost = false;
        }
        if (a.sent_next == a.next_tsn) return null;
        const s = a.slot(a.sent_next);
        if (a.flight + s.len > a.cwnd) return null;
        if (s.len > a.peer_rwnd and a.flight > 0) return null; // нулевое окно: по одной пробе
        return s;
    }

    /// Таймеры: T3-rtx.
    pub fn tick(a: *Association, now_us: u64, sink: Sink) void {
        if (a.state != .established or a.t3_at_us == 0 or now_us < a.t3_at_us) return;
        // Время вышло: всё, что в пути, считается потерянным, окно сжимается до одного пакета.
        var tsn = a.cum_ack +% 1;
        while (before(tsn, a.sent_next)) : (tsn +%= 1) {
            const s = a.slot(tsn);
            if (s.sent and !s.acked and !s.lost) {
                s.lost = true;
                s.misses = 0;
            }
        }
        a.flight = 0;
        a.has_lost = true;
        a.ssthresh = @max(a.cwnd / 2, 4 * mtu_bytes);
        a.cwnd = mtu_bytes;
        a.partial_acked = 0;
        a.fast_recovery = false;
        a.rto_us = @min(a.rto_us * 2, rto_max_us);
        a.t3_at_us = now_us + a.rto_us;
        a.flush(now_us, sink);
    }

    /// Ждать SHUTDOWN незачем: сеанс закончит close_notify DTLS, который идёт следом.
    pub fn abort(a: *Association, sink: Sink) void {
        if (a.state != .established) return;
        var p = Packet.init(a.local_port, a.peer_port, a.peer_tag);
        _ = p.chunk(chunk_abort, 0, 0);
        sink.send(sink.ctx, p.finish());
        a.state = .closed;
    }
};

// ---------------------------------------------------------------------------
// Тесты: пакеты собеседника собраны вручную.

const Capture = struct {
    packets: [64][max_packet]u8 = undefined,
    lens: [64]usize = @splat(0),
    count: usize = 0,
    msgs: [16][2048]u8 = undefined,
    msg_lens: [16]usize = @splat(0),
    msg_ppid: [16]u32 = @splat(0),
    msg_count: usize = 0,

    fn send(ctx: *anyopaque, p: []const u8) void {
        const c: *Capture = @ptrCast(@alignCast(ctx));
        @memcpy(c.packets[c.count][0..p.len], p);
        c.lens[c.count] = p.len;
        c.count += 1;
    }
    fn message(ctx: *anyopaque, sid: u16, ppid: u32, data: []const u8) void {
        _ = sid;
        const c: *Capture = @ptrCast(@alignCast(ctx));
        @memcpy(c.msgs[c.msg_count][0..data.len], data);
        c.msg_lens[c.msg_count] = data.len;
        c.msg_ppid[c.msg_count] = ppid;
        c.msg_count += 1;
    }
    fn sink(c: *Capture) Sink {
        return .{ .ctx = c, .send = send, .message = message };
    }
    fn packet(c: *const Capture, i: usize) []const u8 {
        return c.packets[i][0..c.lens[i]];
    }
};

fn peerPacket(buf: []u8, tag: u32, chunks: []const []const u8) []const u8 {
    std.mem.writeInt(u16, buf[0..2], 5000, .big);
    std.mem.writeInt(u16, buf[2..4], 5000, .big);
    std.mem.writeInt(u32, buf[4..8], tag, .big);
    var n: usize = 12;
    for (chunks) |c| {
        @memcpy(buf[n..][0..c.len], c);
        n += (c.len + 3) & ~@as(usize, 3);
    }
    std.mem.writeInt(u32, buf[8..12], checksum(buf[0..n]), .little);
    return buf[0..n];
}

fn dataChunk(buf: []u8, flags: u8, tsn: u32, ppid: u32, payload: []const u8) []const u8 {
    buf[0] = chunk_data;
    buf[1] = flags;
    std.mem.writeInt(u16, buf[2..4], @intCast(16 + payload.len), .big);
    std.mem.writeInt(u32, buf[4..8], tsn, .big);
    std.mem.writeInt(u16, buf[8..10], 0, .big);
    std.mem.writeInt(u16, buf[10..12], 0, .big);
    std.mem.writeInt(u32, buf[12..16], ppid, .big);
    @memcpy(buf[16..][0..payload.len], payload);
    @memset(buf[16 + payload.len ..][0 .. ((payload.len + 3) & ~@as(usize, 3)) - payload.len], 0);
    return buf[0 .. 16 + payload.len];
}

fn sackChunk(buf: []u8, cum: u32, gaps: []const [2]u16) []const u8 {
    buf[0] = chunk_sack;
    buf[1] = 0;
    std.mem.writeInt(u16, buf[2..4], @intCast(16 + gaps.len * 4), .big);
    std.mem.writeInt(u32, buf[4..8], cum, .big);
    std.mem.writeInt(u32, buf[8..12], 1 << 20, .big);
    std.mem.writeInt(u16, buf[12..14], @intCast(gaps.len), .big);
    std.mem.writeInt(u16, buf[14..16], 0, .big);
    for (gaps, 0..) |g, i| {
        std.mem.writeInt(u16, buf[16 + i * 4 ..][0..2], g[0], .big);
        std.mem.writeInt(u16, buf[18 + i * 4 ..][0..2], g[1], .big);
    }
    return buf[0 .. 16 + gaps.len * 4];
}

const peer_tag_test: u32 = 0x11223344;
const peer_tsn_test: u32 = 0xFFFF_FFFE; // за время теста номер пройдёт через ноль

fn established(io: std.Io, a: *Association, cap: *Capture) !void {
    a.init(io);
    var init_chunk: [20]u8 = undefined;
    init_chunk[0] = chunk_init;
    init_chunk[1] = 0;
    std.mem.writeInt(u16, init_chunk[2..4], 20, .big);
    std.mem.writeInt(u32, init_chunk[4..8], peer_tag_test, .big);
    std.mem.writeInt(u32, init_chunk[8..12], 1 << 20, .big);
    std.mem.writeInt(u16, init_chunk[12..14], 65535, .big);
    std.mem.writeInt(u16, init_chunk[14..16], 65535, .big);
    std.mem.writeInt(u32, init_chunk[16..20], peer_tsn_test, .big);
    var buf: [256]u8 = undefined;
    a.handlePacket(peerPacket(&buf, 0, &.{&init_chunk}), 0, cap.sink());
    try std.testing.expectEqual(@as(usize, 1), cap.count);
    const ack = cap.packet(0);
    try std.testing.expectEqual(peer_tag_test, std.mem.readInt(u32, ack[4..8], .big));
    try std.testing.expectEqual(checksum(ack), std.mem.readInt(u32, ack[8..12], .little));
    try std.testing.expectEqual(chunk_init_ack, ack[12]);
    const cookie = ack[12 + 4 + 20 ..][0..16];
    var echo: [20]u8 = undefined;
    echo[0] = chunk_cookie_echo;
    echo[1] = 0;
    std.mem.writeInt(u16, echo[2..4], 20, .big);
    @memcpy(echo[4..20], cookie);
    a.handlePacket(peerPacket(&buf, a.my_tag, &.{&echo}), 0, cap.sink());
    try std.testing.expectEqual(State.established, a.state);
    try std.testing.expectEqual(chunk_cookie_ack, cap.packet(1)[12]);
    cap.count = 0;
}

test "sctp: проверочное значение CRC-32C" {
    try std.testing.expectEqual(@as(u32, 0xE3069283), Crc32c.hash("123456789"));
}

test "sctp: ассоциация, порядок при перестановке пакетов, пропуски в SACK" {
    var threaded: std.Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    const a = try std.testing.allocator.create(Association);
    defer std.testing.allocator.destroy(a);
    var cap: Capture = .{};
    try established(threaded.io(), a, &cap);

    var buf: [1300]u8 = undefined;
    var c1: [64]u8 = undefined;
    var c2: [64]u8 = undefined;
    var c3: [64]u8 = undefined;
    // Сообщение из двух частей, потом целое; вторая часть приходит первой.
    const t0 = peer_tsn_test;
    a.handlePacket(peerPacket(&buf, a.my_tag, &.{dataChunk(&c2, flag_end, t0 +% 1, ppid_string, "world")}), 1, cap.sink());
    try std.testing.expectEqual(@as(usize, 0), cap.msg_count);
    const sack1 = cap.packet(cap.count - 1);
    try std.testing.expectEqual(chunk_sack, sack1[12]);
    try std.testing.expectEqual(t0 -% 1, std.mem.readInt(u32, sack1[16..20], .big)); // по порядку пока ничего
    try std.testing.expectEqual(@as(u16, 1), std.mem.readInt(u16, sack1[24..26], .big)); // один блок с пропуском
    a.handlePacket(peerPacket(&buf, a.my_tag, &.{ dataChunk(&c1, flag_begin, t0, ppid_string, "hello "), dataChunk(&c3, flag_begin | flag_end, t0 +% 2, ppid_binary, &.{ 1, 2, 3 }) }), 2, cap.sink());
    try std.testing.expectEqual(@as(usize, 2), cap.msg_count);
    try std.testing.expectEqualStrings("hello world", cap.msgs[0][0..cap.msg_lens[0]]);
    try std.testing.expectEqual(ppid_binary, cap.msg_ppid[1]);
    const sack2 = cap.packet(cap.count - 1);
    try std.testing.expectEqual(t0 +% 2, std.mem.readInt(u32, sack2[16..20], .big));
    // О повторе сообщается, второй раз он не отдаётся.
    a.handlePacket(peerPacket(&buf, a.my_tag, &.{dataChunk(&c3, flag_begin | flag_end, t0 +% 2, ppid_binary, &.{ 1, 2, 3 })}), 3, cap.sink());
    try std.testing.expectEqual(@as(usize, 2), cap.msg_count);
    try std.testing.expectEqual(@as(u16, 1), std.mem.readInt(u16, cap.packet(cap.count - 1)[26..28], .big));
    // Не та метка проверки или контрольная сумма — пакет не замечаем.
    const before_count = cap.count;
    a.handlePacket(peerPacket(&buf, 12345, &.{dataChunk(&c3, flag_begin | flag_end, t0 +% 3, ppid_binary, &.{9})}), 4, cap.sink());
    var bad = peerPacket(&buf, a.my_tag, &.{dataChunk(&c3, flag_begin | flag_end, t0 +% 3, ppid_binary, &.{9})});
    buf[bad.len - 1] ^= 0xFF;
    bad = buf[0..bad.len];
    a.handlePacket(bad, 4, cap.sink());
    try std.testing.expectEqual(before_count, cap.count);
    try std.testing.expectEqual(@as(usize, 2), cap.msg_count);
}

test "sctp: отправка, SACK, быстрый повтор и таймер T3" {
    var threaded: std.Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    const a = try std.testing.allocator.create(Association);
    defer std.testing.allocator.destroy(a);
    var cap: Capture = .{};
    try established(threaded.io(), a, &cap);

    var big: [5000]u8 = undefined;
    for (&big, 0..) |*b, i| b.* = @truncate(i);
    try a.queueMessage(0, ppid_binary, &big);
    try std.testing.expectEqual(@as(usize, 5), a.usedSlots());
    a.flush(0, cap.sink());
    try std.testing.expectEqual(@as(usize, 5), cap.count);
    const first = cap.packet(0);
    try std.testing.expectEqual(chunk_data, first[12]);
    try std.testing.expect(first[13] & flag_begin != 0);
    try std.testing.expect(cap.packet(4)[13] & flag_end != 0);
    try std.testing.expect(cap.packet(4)[13] & flag_immediate != 0);
    const tsn0 = a.my_initial_tsn;

    // Собеседник получил 0, 2, 3, 4, но не 1: три SACK с пропуском вызывают быстрый повтор 1.
    var buf: [256]u8 = undefined;
    var s: [64]u8 = undefined;
    cap.count = 0;
    a.handlePacket(peerPacket(&buf, a.my_tag, &.{sackChunk(&s, tsn0, &.{.{ 2, 2 }})}), 10_000, cap.sink());
    a.handlePacket(peerPacket(&buf, a.my_tag, &.{sackChunk(&s, tsn0, &.{.{ 2, 3 }})}), 11_000, cap.sink());
    try std.testing.expectEqual(@as(usize, 0), cap.count);
    a.handlePacket(peerPacket(&buf, a.my_tag, &.{sackChunk(&s, tsn0, &.{.{ 2, 4 }})}), 12_000, cap.sink());
    try std.testing.expectEqual(@as(usize, 1), cap.count);
    try std.testing.expectEqual(tsn0 +% 1, std.mem.readInt(u32, cap.packet(0)[16..20], .big));
    try std.testing.expect(a.fast_recovery);
    // Всё подтверждено: ячейки снова свободны.
    a.handlePacket(peerPacket(&buf, a.my_tag, &.{sackChunk(&s, tsn0 +% 4, &.{})}), 20_000, cap.sink());
    try std.testing.expectEqual(@as(usize, 0), a.usedSlots());
    try std.testing.expectEqual(@as(u32, 0), a.flight);
    try std.testing.expectEqual(@as(u64, 0), a.t3_at_us);
    try std.testing.expect(!a.fast_recovery);

    // SACK нет вовсе: по истечении RTO самый старый блок уходит снова, окно — один пакет.
    try a.queueMessage(0, ppid_string, "ping");
    cap.count = 0;
    a.flush(30_000, cap.sink());
    try std.testing.expectEqual(@as(usize, 1), cap.count);
    a.tick(30_000 + a.rto_us - 1, cap.sink());
    try std.testing.expectEqual(@as(usize, 1), cap.count);
    a.tick(30_000 + a.rto_us, cap.sink());
    try std.testing.expectEqual(@as(usize, 2), cap.count);
    try std.testing.expectEqual(tsn0 +% 5, std.mem.readInt(u32, cap.packet(1)[16..20], .big));
    try std.testing.expectEqual(mtu_bytes, a.cwnd);
}

test "sctp: окно ограничивает залп" {
    var threaded: std.Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    const a = try std.testing.allocator.create(Association);
    defer std.testing.allocator.destroy(a);
    var cap: Capture = .{};
    try established(threaded.io(), a, &cap);
    var big: [40 * max_chunk_data]u8 = @splat(7);
    try a.queueMessage(0, ppid_binary, &big);
    a.flush(0, cap.sink());
    // Начальное окно — десять пакетов.
    try std.testing.expectEqual(@as(usize, 10), cap.count);
    const huge = try std.testing.allocator.alloc(u8, send_slots * max_chunk_data);
    defer std.testing.allocator.free(huge);
    try std.testing.expectError(error.Full, a.queueMessage(0, ppid_binary, huge));
}

test "sctp: ассоциация настраивается на месте, даже из потока с малым стеком" {
    var threaded: std.Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    const T = struct {
        fn run(io: std.Io, a: *Association) void {
            a.init(io);
        }
    };
    const a = try std.testing.allocator.create(Association);
    defer std.testing.allocator.destroy(a);
    const t = try std.Thread.spawn(.{ .stack_size = 64 * 1024 }, T.run, .{ threaded.io(), a });
    t.join();
    try std.testing.expectEqual(State.listen, a.state);
    try std.testing.expectEqual(@as(usize, 0), a.usedSlots());
}
