//! RTCP (RFC 3550; обратная связь — RFC 4585, RFC 5104): обход составного пакета и перевод
//! SSRC между плечами. Узел пересылает отчёты и запросы как есть — потери, повторы (NACK),
//! запросы ключевого кадра (PLI, FIR), оценки полосы (REMB, transport-cc) остаются делом
//! двух браузеров, — и меняет только номера потоков: у каждого плеча они свои.
//! Чистая логика над байтами.
const std = @import("std");

pub const pt_sr: u8 = 200;
pub const pt_rr: u8 = 201;
pub const pt_sdes: u8 = 202;
pub const pt_bye: u8 = 203;
pub const pt_app: u8 = 204;
pub const pt_rtpfb: u8 = 205;
pub const pt_psfb: u8 = 206;
pub const pt_xr: u8 = 207;

const fmt_nack: u8 = 1;
const fmt_tmmbr: u8 = 3;
const fmt_tmmbn: u8 = 4;
const fmt_twcc: u8 = 15;
const fmt_pli: u8 = 1;
const fmt_fir: u8 = 4;
const fmt_afb: u8 = 15;

/// Что прошло через узел: для его счётчиков.
pub const Seen = struct {
    sr: u32 = 0,
    rr: u32 = 0,
    nack: u32 = 0,
    pli: u32 = 0,
    fir: u32 = 0,
    remb: u32 = 0,
    twcc: u32 = 0,
    /// Пакеты незнакомых типов: выброшены.
    dropped: u32 = 0,
};

/// Перевод одного SSRC: чего плечо не знает, возвращается как есть.
pub const Mapper = struct {
    ctx: *const anyopaque,
    map: *const fn (ctx: *const anyopaque, ssrc: u32) u32,

    fn apply(m: Mapper, field: *[4]u8) void {
        std.mem.writeInt(u32, field, m.map(m.ctx, std.mem.readInt(u32, field, .big)), .big);
    }
};

/// Переводит все SSRC составного пакета на месте и возвращает его новую длину: пакеты
/// незнакомых типов и то, что не разобралось, выбрасываются.
pub fn translate(buf: []u8, m: Mapper, seen: *Seen) usize {
    var pos: usize = 0;
    var out: usize = 0;
    while (pos + 4 <= buf.len) {
        if (buf[pos] >> 6 != 2) break;
        const size = 4 * (@as(usize, std.mem.readInt(u16, buf[pos + 2 ..][0..2], .big)) + 1);
        if (pos + size > buf.len) break;
        const p = buf[pos..][0..size];
        pos += size;
        if (!translateOne(p, m, seen)) {
            seen.dropped += 1;
            continue;
        }
        if (out != pos - size) std.mem.copyForwards(u8, buf[out..][0..size], p);
        out += size;
    }
    return out;
}

fn translateOne(p: []u8, m: Mapper, seen: *Seen) bool {
    const count: usize = p[0] & 0x1f;
    switch (p[1]) {
        pt_sr, pt_rr => {
            const blocks_at: usize = if (p[1] == pt_sr) 28 else 8;
            if (p.len < blocks_at + count * 24) return false;
            m.apply(p[4..8]);
            for (0..count) |i| m.apply(p[blocks_at + i * 24 ..][0..4]);
            if (p[1] == pt_sr) seen.sr += 1 else seen.rr += 1;
        },
        pt_sdes => {
            // Блоки: SSRC, затем записи «вид, длина, значение» до нулевого вида, выравнивание на слово.
            var pos: usize = 4;
            for (0..count) |_| {
                if (pos + 4 > p.len) return false;
                m.apply(p[pos..][0..4]);
                pos += 4;
                while (true) {
                    if (pos >= p.len) return false;
                    if (p[pos] == 0) {
                        pos = (pos + 4) & ~@as(usize, 3);
                        break;
                    }
                    if (pos + 2 > p.len) return false;
                    pos += 2 + @as(usize, p[pos + 1]);
                }
                if (pos > p.len) return false;
            }
        },
        pt_bye => {
            if (p.len < 4 + count * 4) return false;
            for (0..count) |i| m.apply(p[4 + i * 4 ..][0..4]);
        },
        pt_rtpfb => {
            if (p.len < 12) return false;
            m.apply(p[4..8]);
            m.apply(p[8..12]);
            switch (count) {
                fmt_nack => seen.nack += 1,
                fmt_twcc => seen.twcc += 1,
                fmt_tmmbr, fmt_tmmbn => {
                    var at: usize = 12;
                    while (at + 8 <= p.len) : (at += 8) m.apply(p[at..][0..4]);
                },
                else => {},
            }
        },
        pt_psfb => {
            if (p.len < 12) return false;
            m.apply(p[4..8]);
            m.apply(p[8..12]);
            switch (count) {
                fmt_pli => seen.pli += 1,
                fmt_fir => {
                    // Записи: SSRC, номер запроса, три байта резерва.
                    var at: usize = 12;
                    while (at + 8 <= p.len) : (at += 8) m.apply(p[at..][0..4]);
                    seen.fir += 1;
                },
                fmt_afb => if (p.len >= 20 and std.mem.eql(u8, p[12..16], "REMB")) {
                    const n: usize = p[16];
                    if (p.len < 20 + n * 4) return false;
                    for (0..n) |i| m.apply(p[20 + i * 4 ..][0..4]);
                    seen.remb += 1;
                },
                else => {},
            }
        },
        pt_xr => {
            if (p.len < 8) return false;
            m.apply(p[4..8]);
            var pos: usize = 8;
            while (pos + 4 <= p.len) {
                const body_len = 4 * @as(usize, std.mem.readInt(u16, p[pos + 2 ..][0..2], .big));
                if (pos + 4 + body_len > p.len) return false;
                // DLRR (вид 5): на каждый поток — его SSRC, время последнего отчёта и задержка.
                if (p[pos] == 5) {
                    var at = pos + 4;
                    while (at + 12 <= pos + 4 + body_len) : (at += 12) m.apply(p[at..][0..4]);
                }
                pos += 4 + body_len;
            }
        },
        else => return false,
    }
    return true;
}

pub const pli_len = 20;

/// Запрос ключевого кадра от узла: пустой отчёт получателя (с него обязан начинаться
/// составной пакет) и PLI.
pub fn writePli(out: *[pli_len]u8, sender_ssrc: u32, media_ssrc: u32) []u8 {
    out[0] = 0x80; // версия 2, ни одного блока
    out[1] = pt_rr;
    std.mem.writeInt(u16, out[2..4], 1, .big);
    std.mem.writeInt(u32, out[4..8], sender_ssrc, .big);
    out[8] = 0x80 | fmt_pli;
    out[9] = pt_psfb;
    std.mem.writeInt(u16, out[10..12], 2, .big);
    std.mem.writeInt(u32, out[12..16], sender_ssrc, .big);
    std.mem.writeInt(u32, out[16..20], media_ssrc, .big);
    return out;
}

pub const fir_len = 28;

/// То же через FIR (RFC 5104) — для потока, с отправителем которого о PLI не договорились.
/// `seq` — номер запроса: растёт с каждым новым.
pub fn writeFir(out: *[fir_len]u8, sender_ssrc: u32, media_ssrc: u32, seq: u8) []u8 {
    out[0] = 0x80;
    out[1] = pt_rr;
    std.mem.writeInt(u16, out[2..4], 1, .big);
    std.mem.writeInt(u32, out[4..8], sender_ssrc, .big);
    out[8] = 0x80 | fmt_fir;
    out[9] = pt_psfb;
    std.mem.writeInt(u16, out[10..12], 4, .big);
    std.mem.writeInt(u32, out[12..16], sender_ssrc, .big);
    std.mem.writeInt(u32, out[16..20], 0, .big); // у FIR поток назван в записи, а не в заголовке
    std.mem.writeInt(u32, out[20..24], media_ssrc, .big);
    out[24] = seq;
    @memset(out[25..28], 0);
    return out;
}

fn hexBytes(comptime s: []const u8) [s.len / 2]u8 {
    var out: [s.len / 2]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, s) catch unreachable;
    return out;
}

/// Для тестов: 0xA00000nn ↔ 0xB00000nn, остальное как есть.
const TestMap = struct {
    fn map(ctx: *const anyopaque, ssrc: u32) u32 {
        _ = ctx;
        return switch (ssrc >> 24) {
            0xA0 => (ssrc & 0x00ff_ffff) | 0xB000_0000,
            0xB0 => (ssrc & 0x00ff_ffff) | 0xA000_0000,
            else => ssrc,
        };
    }
    const mapper: Mapper = .{ .ctx = &map, .map = map };
};

test "rtcp: перевод SSRC в отчётах и обратной связи" {
    var buf = hexBytes(
        // RR от a0000001 с одним блоком о потоке b0000002
        "81c90007" ++ "a0000001" ++ "b0000002" ++ "00000000" ++ "00001234" ++ "00000010" ++ "11111111" ++ "22222222" ++
            // PLI: от a0000001 о потоке b0000002
            "81ce0002" ++ "a0000001" ++ "b0000002" ++
            // FIR: поток в записи, а не в заголовке
            "84ce0004" ++ "a0000001" ++ "00000000" ++ "b0000002" ++ "07000000" ++
            // REMB с двумя потоками
            "8fce0006" ++ "a0000001" ++ "00000000" ++ "52454d42" ++ "02" ++ "0bd0e2" ++ "b0000002" ++ "b0000003" ++
            // NACK
            "81cd0003" ++ "a0000001" ++ "b0000002" ++ "12340003" ++
            // APP: узлу незнаком
            "80cc0002" ++ "a0000001" ++ "74657374" ++
            // transport-cc: тело без SSRC
            "8fcd0005" ++ "a0000001" ++ "b0000002" ++ "0001000100000100" ++ "20010000");
    var seen: Seen = .{};
    const n = translate(&buf, TestMap.mapper, &seen);
    const want = hexBytes("81c90007" ++ "b0000001" ++ "a0000002" ++ "00000000" ++ "00001234" ++ "00000010" ++ "11111111" ++ "22222222" ++
        "81ce0002" ++ "b0000001" ++ "a0000002" ++
        "84ce0004" ++ "b0000001" ++ "00000000" ++ "a0000002" ++ "07000000" ++
        "8fce0006" ++ "b0000001" ++ "00000000" ++ "52454d42" ++ "02" ++ "0bd0e2" ++ "a0000002" ++ "a0000003" ++
        "81cd0003" ++ "b0000001" ++ "a0000002" ++ "12340003" ++
        "8fcd0005" ++ "b0000001" ++ "a0000002" ++ "0001000100000100" ++ "20010000");
    try std.testing.expectEqualSlices(u8, &want, buf[0..n]);
    try std.testing.expectEqual(Seen{ .rr = 1, .pli = 1, .fir = 1, .remb = 1, .nack = 1, .twcc = 1, .dropped = 1 }, seen);
}

test "rtcp: отчёт отправителя, SDES, BYE и XR" {
    var buf = hexBytes(
        // SR от a0000001: время NTP и RTP, счётчики; один блок о b0000002
        "81c8000c" ++ "a0000001" ++ "e0000000" ++ "00000001" ++ "00015f90" ++ "00000064" ++ "00002710" ++
            "b0000002" ++ "00000000" ++ "00000001" ++ "00000002" ++ "00000003" ++ "00000004" ++
            // SDES: два блока с CNAME, второй с выравниванием
            "82ca0007" ++ "a0000001" ++ "0103616263" ++ "000000" ++ "a0000004" ++ "0106616263646566" ++ "00000000" ++
            // BYE двух потоков
            "82cb0002" ++ "a0000001" ++ "a0000004" ++
            // XR: время получателя (вид 4) и DLRR (вид 5) с одним потоком
            "80cf0008" ++ "a0000001" ++ "04000002" ++ "e000000000000002" ++ "05000003" ++ "b0000002" ++ "0000aaaa" ++ "0000bbbb");
    var seen: Seen = .{};
    const n = translate(&buf, TestMap.mapper, &seen);
    try std.testing.expectEqual(buf.len, n);
    const want = hexBytes("81c8000c" ++ "b0000001" ++ "e0000000" ++ "00000001" ++ "00015f90" ++ "00000064" ++ "00002710" ++
        "a0000002" ++ "00000000" ++ "00000001" ++ "00000002" ++ "00000003" ++ "00000004" ++
        "82ca0007" ++ "b0000001" ++ "0103616263" ++ "000000" ++ "b0000004" ++ "0106616263646566" ++ "00000000" ++
        "82cb0002" ++ "b0000001" ++ "b0000004" ++
        "80cf0008" ++ "b0000001" ++ "04000002" ++ "e000000000000002" ++ "05000003" ++ "a0000002" ++ "0000aaaa" ++ "0000bbbb");
    try std.testing.expectEqualSlices(u8, &want, &buf);
    try std.testing.expectEqual(@as(u32, 1), seen.sr);
}

test "rtcp: испорченные пакеты не читаются за границей" {
    var seen: Seen = .{};
    // Длина больше датаграммы; отчёт, которому не хватает блоков; REMB с лишним счётчиком потоков;
    // SDES без конца списка; не та версия.
    var long = hexBytes("81c90007" ++ "a0000001");
    try std.testing.expectEqual(@as(usize, 0), translate(&long, TestMap.mapper, &seen));
    var short = hexBytes("83c90001" ++ "a0000001");
    try std.testing.expectEqual(@as(usize, 0), translate(&short, TestMap.mapper, &seen));
    var remb = hexBytes("8fce0004" ++ "a0000001" ++ "00000000" ++ "52454d42" ++ "09000000");
    try std.testing.expectEqual(@as(usize, 0), translate(&remb, TestMap.mapper, &seen));
    var sdes = hexBytes("81ca0002" ++ "a0000001" ++ "01ff6162");
    try std.testing.expectEqual(@as(usize, 0), translate(&sdes, TestMap.mapper, &seen));
    var version = hexBytes("41c90001" ++ "a0000001");
    try std.testing.expectEqual(@as(usize, 0), translate(&version, TestMap.mapper, &seen));
    // Хороший пакет перед плохим остаётся.
    var mixed = hexBytes("80c90001" ++ "a0000001" ++ "83c90001" ++ "a0000001");
    try std.testing.expectEqual(@as(usize, 8), translate(&mixed, TestMap.mapper, &seen));
    try std.testing.expectEqualSlices(u8, &hexBytes("80c90001" ++ "b0000001"), mixed[0..8]);
}

// Пакеты приходят из сети: разбор не должен выйти за границы, что бы в них ни было.
test "rtcp: случайные байты разбор не роняют" {
    var prng: std.Random.DefaultPrng = .init(0x52544350);
    const rnd = prng.random();
    var buf: [256]u8 = undefined;
    var seen: Seen = .{};
    for (0..20000) |_| {
        const len = rnd.uintLessThan(usize, buf.len);
        rnd.bytes(buf[0..len]);
        // Чаще похоже на RTCP: версия 2 и тип из известных.
        if (len >= 4 and rnd.boolean()) {
            buf[0] = 0x80 | (buf[0] & 0x1f);
            buf[1] = 200 + (buf[1] % 8);
            std.mem.writeInt(u16, buf[2..4], rnd.uintLessThan(u16, 70), .big);
        }
        const n = translate(buf[0..len], TestMap.mapper, &seen);
        try std.testing.expect(n <= len);
    }
}

test "rtcp: запрос ключевого кадра от узла" {
    var buf: [pli_len]u8 = undefined;
    const p = writePli(&buf, 0x11111111, 0x22222222);
    try std.testing.expectEqualSlices(u8, &hexBytes("80c90001" ++ "11111111" ++ "81ce0002" ++ "11111111" ++ "22222222"), p);
    var seen: Seen = .{};
    try std.testing.expectEqual(@as(usize, pli_len), translate(p, TestMap.mapper, &seen));
    try std.testing.expectEqual(@as(u32, 1), seen.pli);

    var fir_buf: [fir_len]u8 = undefined;
    const f = writeFir(&fir_buf, 0x11111111, 0xa0000002, 7);
    try std.testing.expectEqualSlices(u8, &hexBytes("80c90001" ++ "11111111" ++ "84ce0004" ++ "11111111" ++ "00000000" ++ "a0000002" ++ "07000000"), f);
    // Такой запрос читается как FIR, и поток в его записи переводится.
    try std.testing.expectEqual(@as(usize, fir_len), translate(f, TestMap.mapper, &seen));
    try std.testing.expectEqual(@as(u32, 1), seen.fir);
    try std.testing.expectEqualSlices(u8, &hexBytes("b0000002"), f[20..24]);
}
