//! RTP (RFC 3550): разбор заголовка и правка того, что узел меняет при пересылке, —
//! SSRC, тип нагрузки и номера расширений заголовка (RFC 8285). Нагрузку узел не трогает.
//! Чистая логика над байтами.
const std = @import("std");

pub const min_header = 12;

/// Первые байты датаграммы: RTP или RTCP (RFC 7983), а не STUN и не DTLS.
pub fn isRtpOrRtcp(data: []const u8) bool {
    return data.len >= 2 and data[0] >= 128 and data[0] <= 191;
}

/// RTCP делит порт с RTP: его типы пакетов 192–223 не пересекаются с типами нагрузки (RFC 5761).
pub fn isRtcp(data: []const u8) bool {
    return data.len >= 2 and data[1] >= 192 and data[1] <= 223;
}

/// Длина заголовка вместе со списком CSRC и расширением; null — пакет испорчен.
pub fn headerLen(p: []const u8) ?usize {
    if (p.len < min_header or p[0] >> 6 != 2) return null;
    var n: usize = min_header + 4 * @as(usize, p[0] & 0x0f);
    if (p[0] & 0x10 != 0) {
        if (p.len < n + 4) return null;
        n += 4 + 4 * @as(usize, std.mem.readInt(u16, p[n + 2 ..][0..2], .big));
    }
    if (n > p.len) return null;
    return n;
}

pub const Header = struct {
    pt: u7,
    marker: bool,
    seq: u16,
    timestamp: u32,
    ssrc: u32,
    /// Весь заголовок: с CSRC и расширением.
    len: usize,
    /// Расширение заголовка: его вид (0xBEDE — однобайтовые элементы, 0x100x — двухбайтовые)
    /// и где лежат элементы.
    ext_profile: u16 = 0,
    ext_at: usize = 0,
    ext_len: usize = 0,
};

pub fn parse(p: []const u8) ?Header {
    const len = headerLen(p) orelse return null;
    var h: Header = .{
        .pt = @truncate(p[1]),
        .marker = p[1] & 0x80 != 0,
        .seq = std.mem.readInt(u16, p[2..4], .big),
        .timestamp = std.mem.readInt(u32, p[4..8], .big),
        .ssrc = std.mem.readInt(u32, p[8..12], .big),
        .len = len,
    };
    if (p[0] & 0x10 != 0) {
        const at = min_header + 4 * @as(usize, p[0] & 0x0f);
        h.ext_profile = std.mem.readInt(u16, p[at..][0..2], .big);
        h.ext_at = at + 4;
        h.ext_len = len - at - 4;
    }
    return h;
}

pub fn setSsrc(p: []u8, ssrc: u32) void {
    std.mem.writeInt(u32, p[8..12], ssrc, .big);
}

pub fn setPayloadType(p: []u8, pt: u7) void {
    p[1] = (p[1] & 0x80) | pt;
}

const one_byte_profile: u16 = 0xBEDE;

fn twoByte(profile: u16) bool {
    return profile & 0xFFF0 == 0x1000;
}

/// Обходит элементы расширения заголовка. Незнакомый вид расширения — элементов нет.
pub const ExtIterator = struct {
    data: []u8,
    two: bool,
    pos: usize = 0,

    pub const Element = struct {
        id: u8,
        /// Где лежит номер элемента и его значение.
        at: usize,
        value: []u8,
        /// Элемент целиком: с заголовком.
        whole: []u8,
    };

    pub fn init(p: []u8, h: Header) ExtIterator {
        const known = h.ext_profile == one_byte_profile or twoByte(h.ext_profile);
        return .{ .data = if (known) p[h.ext_at..][0..h.ext_len] else p[0..0], .two = twoByte(h.ext_profile) };
    }

    pub fn next(it: *ExtIterator) ?Element {
        const d = it.data;
        while (it.pos < d.len) {
            if (d[it.pos] == 0) { // заполнитель
                it.pos += 1;
                continue;
            }
            const at = it.pos;
            var id: u8 = undefined;
            var head: usize = undefined;
            var len: usize = undefined;
            if (it.two) {
                if (at + 2 > d.len) return null;
                id = d[at];
                len = d[at + 1];
                head = 2;
            } else {
                id = d[at] >> 4;
                if (id == 15) return null; // зарезервирован: дальше не читать
                len = @as(usize, d[at] & 0x0f) + 1;
                head = 1;
            }
            if (at + head + len > d.len) return null;
            it.pos = at + head + len;
            return .{ .id = id, .at = at, .value = d[at + head ..][0..len], .whole = d[at .. at + head + len] };
        }
        return null;
    }
};

/// Значение расширения с данным номером или null.
pub fn extension(p: []u8, h: Header, id: u8) ?[]const u8 {
    if (id == 0) return null;
    var it = ExtIterator.init(p, h);
    while (it.next()) |e| if (e.id == id) return e.value;
    return null;
}

/// Как расширения заголовка переезжают с одного плеча на другое: у каждого плеча свои номера.
pub const ExtRewrite = struct {
    /// Номер на входящем плече → номер на исходящем; 0 — на исходящем такого расширения нет.
    map: [256]u8 = @splat(0),
    /// Номер расширения MID на входящем плече (0 — нет) и MID секции на исходящем.
    mid_id: u8 = 0,
    mid: []const u8 = "",
};

/// Переписывает номера расширений на месте. Чего исходящее плечо не знает, затирается нулями
/// — это заполнитель. MID у плеч свой: значение заменяется, а если длина другая — затирается
/// (получатель различит поток и по SSRC).
pub fn rewriteExtensions(p: []u8, h: Header, rw: *const ExtRewrite) void {
    var it = ExtIterator.init(p, h);
    while (it.next()) |e| {
        var to = rw.map[e.id];
        if (!it.two and to > 14) to = 0;
        if (to != 0 and e.id == rw.mid_id) {
            if (e.value.len == rw.mid.len) @memcpy(e.value, rw.mid) else to = 0;
        }
        if (to == 0) {
            @memset(e.whole, 0);
        } else if (it.two) {
            it.data[e.at] = to;
        } else {
            it.data[e.at] = (to << 4) | (it.data[e.at] & 0x0f);
        }
    }
}

// Пакеты приходят из сети: разбор не должен выйти за границы, что бы в них ни было.
test "rtp: случайные байты разбор не роняют" {
    var prng: std.Random.DefaultPrng = .init(0x525450);
    const rnd = prng.random();
    var buf: [128]u8 = undefined;
    var rw: ExtRewrite = .{ .mid_id = 4, .mid = "12" };
    for (&rw.map, 0..) |*m, i| m.* = if (i % 3 == 0) 0 else @truncate(i * 7);
    for (0..20000) |_| {
        const len = rnd.uintLessThan(usize, buf.len);
        rnd.bytes(buf[0..len]);
        if (len >= 16 and rnd.boolean()) {
            // Чаще похоже на RTP с расширением заголовка того или другого вида.
            buf[0] = 0x90 | (buf[0] & 0x03);
            const at = 12 + 4 * @as(usize, buf[0] & 0x0f);
            if (at + 4 <= len) {
                std.mem.writeInt(u16, buf[at..][0..2], if (rnd.boolean()) 0xBEDE else 0x1000, .big);
                std.mem.writeInt(u16, buf[at + 2 ..][0..2], rnd.uintLessThan(u16, 12), .big);
            }
        }
        const p = buf[0..len];
        const h = parse(p) orelse continue;
        try std.testing.expect(h.len <= len);
        _ = extension(p, h, rnd.int(u8));
        rewriteExtensions(p, h, &rw);
    }
}

fn hexBytes(comptime s: []const u8) [s.len / 2]u8 {
    var out: [s.len / 2]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, s) catch unreachable;
    return out;
}

test "rtp: заголовок с расширением" {
    // V=2, X=1, PT=96 с маркером, seq 0x1234, ts 0x01020304, SSRC 0xcafebabe;
    // расширение 0xBEDE на два слова: id 1 (уровень звука, 1 байт), id 4 (MID «1»), заполнители.
    var p = hexBytes("90e0123401020304cafebabe" ++ "bede0002" ++ "10aa" ++ "4031" ++ "00000000" ++ "deadbeef");
    try std.testing.expect(isRtpOrRtcp(&p));
    try std.testing.expect(!isRtcp(&p));
    const h = parse(&p).?;
    try std.testing.expectEqual(@as(u7, 96), h.pt);
    try std.testing.expect(h.marker);
    try std.testing.expectEqual(@as(u16, 0x1234), h.seq);
    try std.testing.expectEqual(@as(u32, 0x01020304), h.timestamp);
    try std.testing.expectEqual(@as(u32, 0xcafebabe), h.ssrc);
    try std.testing.expectEqual(@as(usize, 24), h.len);
    try std.testing.expectEqualSlices(u8, &.{0xaa}, extension(&p, h, 1).?);
    try std.testing.expectEqualStrings("1", extension(&p, h, 4).?);
    try std.testing.expectEqual(@as(?[]const u8, null), extension(&p, h, 2));

    // На другом плече уровень звука — номер 3, MID — номер 9 и секция «7».
    var rw: ExtRewrite = .{ .mid_id = 4, .mid = "7" };
    rw.map[1] = 3;
    rw.map[4] = 9;
    rewriteExtensions(&p, h, &rw);
    try std.testing.expectEqualSlices(u8, &hexBytes("30aa" ++ "9037" ++ "00000000"), p[16..24]);
    try std.testing.expectEqualSlices(u8, &hexBytes("deadbeef"), p[24..]); // нагрузка не тронута
    // MID другой длины и расширение, которого на том плече нет, затираются.
    rw = .{ .mid_id = 9, .mid = "10" };
    rw.map[9] = 9;
    rewriteExtensions(&p, h, &rw);
    try std.testing.expectEqualSlices(u8, &hexBytes("0000" ++ "0000" ++ "00000000"), p[16..24]);

    setSsrc(&p, 0x11223344);
    setPayloadType(&p, 100);
    const h2 = parse(&p).?;
    try std.testing.expectEqual(@as(u32, 0x11223344), h2.ssrc);
    try std.testing.expectEqual(@as(u7, 100), h2.pt);
    try std.testing.expect(h2.marker);
}

test "rtp: двухбайтовые расширения и мусор" {
    // Вид 0x1000: id 5 длиной 0, id 20 длиной 3, заполнитель.
    var p = hexBytes("9060000100000000000000aa" ++ "10000002" ++ "0500" ++ "1403a1a2a3" ++ "00" ++ "ff");
    const h = parse(&p).?;
    try std.testing.expectEqual(@as(usize, 0), extension(&p, h, 5).?.len);
    try std.testing.expectEqualSlices(u8, &.{ 0xa1, 0xa2, 0xa3 }, extension(&p, h, 20).?);
    var rw: ExtRewrite = .{};
    rw.map[20] = 200;
    rewriteExtensions(&p, h, &rw);
    try std.testing.expectEqualSlices(u8, &hexBytes("0000" ++ "c803a1a2a3" ++ "00"), p[16..24]);

    // Обрезанный пакет, не та версия, расширение длиннее пакета, элемент длиннее расширения.
    try std.testing.expectEqual(@as(?Header, null), parse(p[0..11]));
    var bad = hexBytes("1060000100000000000000aa");
    try std.testing.expectEqual(@as(?Header, null), parse(&bad));
    var long = hexBytes("9060000100000000000000aa" ++ "bede0005" ++ "10aa");
    try std.testing.expectEqual(@as(?Header, null), parse(&long));
    var over = hexBytes("9060000100000000000000aa" ++ "bede0001" ++ "1f000000");
    const ho = parse(&over).?;
    try std.testing.expectEqual(@as(?[]const u8, null), extension(&over, ho, 1));
    // Три CSRC перед расширением.
    var csrc = hexBytes("9360000100000000000000aa" ++ "000000010000000200000003" ++ "bede0001" ++ "22010200" ++ "77");
    const hc = parse(&csrc).?;
    try std.testing.expectEqual(@as(usize, 32), hc.len);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 0 }, extension(&csrc, hc, 2).?);
    // RTCP (тип 200) отличим от RTP.
    try std.testing.expect(isRtcp(&.{ 0x80, 200, 0, 6 }));
}
