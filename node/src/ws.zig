//! WebSocket (RFC 6455) со стороны клиента: то, что нужно узлу, чтобы говорить с брокером MQTT
//! поверх WebSocket, как страница. Только чистая логика над байтами — без сокетов.
const std = @import("std");

pub const Opcode = enum(u4) {
    continuation = 0,
    text = 1,
    binary = 2,
    close = 8,
    ping = 9,
    pong = 10,
    _,
};

const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Значение Sec-WebSocket-Accept, которым сервер должен ответить на ключ клиента.
pub fn acceptKey(key: []const u8, out: *[28]u8) []const u8 {
    var h = std.crypto.hash.Sha1.init(.{});
    h.update(key);
    h.update(guid);
    var digest: [20]u8 = undefined;
    h.final(&digest);
    return std.base64.standard.Encoder.encode(out, &digest);
}

/// Заголовок кадра от клиента к серверу: всегда с маской (RFC 6455, раздел 5.3).
/// Возвращает занятую часть buf.
pub fn clientHeader(buf: *[14]u8, opcode: Opcode, payload_len: usize, mask: [4]u8) []const u8 {
    buf[0] = 0x80 | @as(u8, @backingInt(opcode));
    var pos: usize = 2;
    if (payload_len < 126) {
        buf[1] = 0x80 | @as(u8, @intCast(payload_len));
    } else if (payload_len <= 0xFFFF) {
        buf[1] = 0x80 | 126;
        std.mem.writeInt(u16, buf[2..4], @intCast(payload_len), .big);
        pos = 4;
    } else {
        buf[1] = 0x80 | 127;
        std.mem.writeInt(u64, buf[2..10], payload_len, .big);
        pos = 10;
    }
    @memcpy(buf[pos..][0..4], &mask);
    return buf[0 .. pos + 4];
}

pub const ServerHeader = struct {
    fin: bool,
    opcode: Opcode,
    /// Длина содержимого кадра.
    len: u64,
    /// Длина заголовка.
    used: usize,
};

/// Заголовок кадра от сервера к клиенту с начала buf. null — данных пока мало.
/// Содержимое читается отдельно: кадр может быть большим.
pub fn parseServerHeader(buf: []const u8) error{Masked}!?ServerHeader {
    if (buf.len < 2) return null;
    if (buf[1] & 0x80 != 0) return error.Masked; // сервер маску не ставит никогда
    var pos: usize = 2;
    var n: u64 = buf[1] & 0x7F;
    if (n == 126) {
        if (buf.len < 4) return null;
        n = std.mem.readInt(u16, buf[2..4], .big);
        pos = 4;
    } else if (n == 127) {
        if (buf.len < 10) return null;
        n = std.mem.readInt(u64, buf[2..10], .big);
        pos = 10;
    }
    return .{ .fin = buf[0] & 0x80 != 0, .opcode = @fromBackingInt(@intCast(@as(u4, @truncate(buf[0])))), .len = n, .used = pos };
}

test "ws: заголовок кадра клиента" {
    // «Hello» с маской из RFC 6455, раздел 5.7.
    const mask = [4]u8{ 0x37, 0xfa, 0x21, 0x3d };
    var hb: [14]u8 = undefined;
    try std.testing.expectEqualSlices(u8, &.{ 0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d }, clientHeader(&hb, .text, 5, mask));
    // Длина в два байта и в восемь.
    try std.testing.expectEqualSlices(u8, &.{ 0x82, 0x80 | 126, 0x01, 0x00, 0x37, 0xfa, 0x21, 0x3d }, clientHeader(&hb, .binary, 256, mask));
    try std.testing.expectEqual(@as(usize, 14), clientHeader(&hb, .binary, 70_000, mask).len);
}

test "ws: заголовок кадра сервера" {
    const short = (try parseServerHeader(&.{ 0x82, 5, 0xaa })).?;
    try std.testing.expectEqual(Opcode.binary, short.opcode);
    try std.testing.expectEqual(@as(u64, 5), short.len);
    try std.testing.expectEqual(@as(usize, 2), short.used);
    try std.testing.expect(short.fin);
    const medium = (try parseServerHeader(&.{ 0x01, 126, 0x01, 0x00 })).?;
    try std.testing.expectEqual(Opcode.text, medium.opcode);
    try std.testing.expectEqual(@as(u64, 256), medium.len);
    try std.testing.expect(!medium.fin);
    const long = (try parseServerHeader(&.{ 0x82, 127, 0, 0, 0, 0, 0, 0x01, 0x11, 0x70 })).?;
    try std.testing.expectEqual(@as(u64, 70_000), long.len);
    try std.testing.expectEqual(@as(usize, 10), long.used);
    try std.testing.expectEqual(Opcode.ping, (try parseServerHeader(&.{ 0x89, 0 })).?.opcode);
    // Неполный заголовок и кадр с маской.
    try std.testing.expectEqual(@as(?ServerHeader, null), try parseServerHeader(&.{0x82}));
    try std.testing.expectEqual(@as(?ServerHeader, null), try parseServerHeader(&.{ 0x82, 126, 0x01 }));
    try std.testing.expectError(error.Masked, parseServerHeader(&.{ 0x81, 0x85 }));
}

test "ws: ключ из RFC 6455" {
    var out: [28]u8 = undefined;
    try std.testing.expectEqualStrings("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", acceptKey("dGhlIHNhbXBsZSBub25jZQ==", &out));
}
