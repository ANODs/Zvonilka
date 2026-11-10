//! Пакеты MQTT 3.1.1 для сигналинга через публичные брокеры: от узла — CONNECT, SUBSCRIBE,
//! PUBLISH (QoS 0) и PINGREQ, к узлу — CONNACK, SUBACK, PUBLISH и PINGRESP.
//! Чистая логика над байтами — без сокетов.
const std = @import("std");

pub const connack_type: u8 = 2;
pub const publish_type: u8 = 3;
pub const suback_type: u8 = 9;
pub const pingresp_type: u8 = 13;

pub const pingreq = [_]u8{ 0xC0, 0x00 };

/// Постоянный заголовок: вид пакета и флаги, затем длина остального (1–4 байта).
fn fixedHeader(out: []u8, first: u8, remaining: usize) usize {
    out[0] = first;
    var n: usize = 1;
    var x = remaining;
    while (true) {
        var byte: u8 = @intCast(x % 128);
        x /= 128;
        if (x > 0) byte |= 0x80;
        out[n] = byte;
        n += 1;
        if (x == 0) break;
    }
    return n;
}

fn str(out: []u8, s: []const u8) usize {
    std.mem.writeInt(u16, out[0..2], @intCast(s.len), .big);
    @memcpy(out[2..][0..s.len], s);
    return 2 + s.len;
}

pub fn connect(out: []u8, client_id: []const u8, keepalive_s: u16) []const u8 {
    const remaining = 10 + 2 + client_id.len;
    var n = fixedHeader(out, 0x10, remaining);
    n += str(out[n..], "MQTT");
    out[n] = 4; // версия протокола 3.1.1
    out[n + 1] = 0x02; // сеанс с чистого листа
    std.mem.writeInt(u16, out[n + 2 ..][0..2], keepalive_s, .big);
    n += 4;
    n += str(out[n..], client_id);
    return out[0..n];
}

pub fn subscribe(out: []u8, packet_id: u16, topic: []const u8) []const u8 {
    var n = fixedHeader(out, 0x82, 2 + 2 + topic.len + 1);
    std.mem.writeInt(u16, out[n..][0..2], packet_id, .big);
    n += 2;
    n += str(out[n..], topic);
    out[n] = 0; // QoS 0
    return out[0 .. n + 1];
}

/// PUBLISH с QoS 0, без хранения у брокера.
pub fn publish(out: []u8, topic: []const u8, payload: []const u8) []const u8 {
    var n = fixedHeader(out, 0x30, 2 + topic.len + payload.len);
    n += str(out[n..], topic);
    @memcpy(out[n..][0..payload.len], payload);
    return out[0 .. n + payload.len];
}

pub fn publishSize(topic: []const u8, payload_len: usize) usize {
    return 5 + 2 + topic.len + payload_len;
}

pub const Packet = struct {
    kind: u8,
    flags: u8,
    body: []const u8,
    /// Сколько байт пакет занимает в буфере.
    used: usize,
};

/// Один пакет с начала buf; null — данных пока мало.
pub fn parse(buf: []const u8, max_len: usize) error{TooLarge}!?Packet {
    if (buf.len < 2) return null;
    var remaining: usize = 0;
    var mult: usize = 1;
    var i: usize = 1;
    while (true) : (i += 1) {
        if (i >= buf.len) return null;
        if (i > 4) return error.TooLarge;
        remaining += @as(usize, buf[i] & 0x7F) * mult;
        if (buf[i] & 0x80 == 0) break;
        mult *= 128;
    }
    if (remaining > max_len) return error.TooLarge;
    const start = i + 1;
    if (buf.len < start + remaining) return null;
    return .{ .kind = buf[0] >> 4, .flags = buf[0] & 0x0F, .body = buf[start .. start + remaining], .used = start + remaining };
}

/// Размер всего пакета в начале buf по одному его постоянному заголовку; null — заголовок неполон
/// или испорчен. Так читающий пропускает пакет, который не берёт, а не рвёт соединение.
pub fn packetLen(buf: []const u8) ?usize {
    if (buf.len < 2) return null;
    var remaining: usize = 0;
    var mult: usize = 1;
    var i: usize = 1;
    while (true) : (i += 1) {
        if (i >= buf.len or i > 4) return null;
        remaining += @as(usize, buf[i] & 0x7F) * mult;
        if (buf[i] & 0x80 == 0) break;
        mult *= 128;
    }
    return i + 1 + remaining;
}

pub const Publish = struct { topic: []const u8, payload: []const u8 };

pub fn parsePublish(p: Packet) ?Publish {
    if (p.body.len < 2) return null;
    const tlen: usize = std.mem.readInt(u16, p.body[0..2], .big); // usize: длина темы 0xFFFF не должна переполниться
    var pos: usize = 2 + tlen;
    if (pos > p.body.len) return null;
    if ((p.flags >> 1) & 3 != 0) pos += 2; // QoS 1 или 2: за темой идёт номер пакета
    if (pos > p.body.len) return null;
    return .{ .topic = p.body[2 .. 2 + tlen], .payload = p.body[pos..] };
}

test "mqtt: пакеты узла читаются обратно" {
    var buf: [512]u8 = undefined;
    const c = connect(&buf, "zvn-1234", 60);
    try std.testing.expectEqualSlices(u8, &.{ 0x10, 20, 0, 4, 'M', 'Q', 'T', 'T', 4, 2, 0, 60, 0, 8 }, c[0..14]);
    const s = subscribe(&buf, 7, "zvn/abc");
    const sp = (try parse(s, 1024)).?;
    try std.testing.expectEqual(@as(u8, 8), sp.kind);
    try std.testing.expectEqual(@as(u8, 2), sp.flags);
    try std.testing.expectEqual(s.len, sp.used);

    var payload: [300]u8 = undefined;
    for (&payload, 0..) |*b, i| b.* = @truncate(i);
    const p = publish(&buf, "zvn/abc", &payload);
    try std.testing.expectEqual(@as(u8, 0x30), p[0]);
    try std.testing.expectEqual(@as(u8, 0x80 | (309 % 128)), p[1]); // 309 = 2 + 7 + 300: длина в двух байтах
    try std.testing.expectEqual(@as(u8, 309 / 128), p[2]);
    try std.testing.expect(publishSize("zvn/abc", payload.len) >= p.len);
    const pp = (try parse(p, 1024)).?;
    try std.testing.expectEqual(publish_type, pp.kind);
    const pub_ = parsePublish(pp).?;
    try std.testing.expectEqualStrings("zvn/abc", pub_.topic);
    try std.testing.expectEqualSlices(u8, &payload, pub_.payload);
    // Неполный, затем слишком большой.
    try std.testing.expectEqual(@as(?Packet, null), try parse(p[0 .. p.len - 1], 1024));
    try std.testing.expectError(error.TooLarge, parse(p, 100));
    try std.testing.expectEqual(@as(?Packet, null), try parse(&.{0x30}, 1024));
}

test "mqtt: пакеты брокера" {
    const connack = [_]u8{ 0x20, 0x02, 0x00, 0x00 };
    const ca = (try parse(&connack, 64)).?;
    try std.testing.expectEqual(connack_type, ca.kind);
    try std.testing.expectEqual(@as(u8, 0), ca.body[1]);
    const ping = [_]u8{ 0xD0, 0x00, 0x90 };
    const pr = (try parse(&ping, 64)).?;
    try std.testing.expectEqual(pingresp_type, pr.kind);
    try std.testing.expectEqual(@as(usize, 2), pr.used);
    // PUBLISH с QoS 1 от брокера несёт за темой номер пакета.
    const q1 = [_]u8{ 0x32, 0x08, 0x00, 0x01, 't', 0x00, 0x05, 'a', 'b', 'c' };
    const p = parsePublish((try parse(&q1, 64)).?).?;
    try std.testing.expectEqualStrings("t", p.topic);
    try std.testing.expectEqualStrings("abc", p.payload);
}
