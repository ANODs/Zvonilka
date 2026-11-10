//! Комната — строка из ссылки. Узлу её дают кодом или целой ссылкой; здесь она приводится
//! к тому же виду, что в `normalizeRoom` и `parseRoom` страницы (web/call.js).
//! Без таблиц Юникода: строчными делаются латиница, кириллица и Latin-1, составные знаки
//! не собираются (NFC). Код, скопированный из ссылки, уже нормализован страницей.
const std = @import("std");

pub const max_len = 64 * 4; // 64 знака, до четырёх байт каждый

/// Код комнаты из того, что передали узлу: код, ссылка страницы (`…/#код`), ссылка Telegram
/// (`…?startapp=код`) или ссылка прежней Звонилки (`…/room/код`). Пустая строка — комнаты нет.
pub fn parse(out: *[max_len]u8, text: []const u8) []const u8 {
    const s = std.mem.trim(u8, text, " \t\r\n");
    var raw: [1024]u8 = undefined;
    for ([_][]const u8{ "?startapp=", "&startapp=", "?tgWebAppStartParam=", "&tgWebAppStartParam=" }) |key| {
        if (std.mem.find(u8, s, key)) |at| {
            const rest = s[at + key.len ..];
            const end = std.mem.findAny(u8, rest, "&# \t") orelse rest.len;
            return fromParam(out, unescape(&raw, rest[0..end]));
        }
    }
    if (std.mem.findScalarLast(u8, s, '#')) |at| {
        if (at + 1 < s.len) return normalize(out, unescape(&raw, s[at + 1 ..]));
    }
    if (std.mem.find(u8, s, "/room/")) |at| {
        const rest = s[at + "/room/".len ..];
        const end = std.mem.findAny(u8, rest, "/?# \t") orelse rest.len;
        if (end > 0) return normalize(out, unescape(&raw, rest[0..end]));
    }
    if (std.mem.find(u8, s, "://") != null) return "";
    return normalize(out, s);
}

/// Стартовый параметр Telegram: код как есть или `X` + hex от UTF-8.
fn fromParam(out: *[max_len]u8, param: []const u8) []const u8 {
    if (param.len >= 3 and param[0] == 'X' and param.len % 2 == 1) {
        var bytes: [512]u8 = undefined;
        if ((param.len - 1) / 2 <= bytes.len) {
            // Страница пишет hex строчными; прописные — это обычный код, который начинается с X.
            const upper_hex = std.mem.findAny(u8, param[1..], "ABCDEF") != null;
            if (std.fmt.hexToBytes(&bytes, param[1..])) |decoded| {
                if (!upper_hex) return normalize(out, decoded);
            } else |_| {}
        }
    }
    return normalize(out, param);
}

/// `%D0%BF` → байты; испорченная последовательность остаётся как есть.
fn unescape(buf: []u8, s: []const u8) []const u8 {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len and n < buf.len) {
        if (s[i] == '%' and i + 2 < s.len) {
            if (std.fmt.parseInt(u8, s[i + 1 .. i + 3], 16)) |b| {
                buf[n] = b;
                n += 1;
                i += 3;
                continue;
            } else |_| {}
        }
        buf[n] = s[i];
        n += 1;
        i += 1;
    }
    return buf[0..n];
}

/// Регистр не важен; всё, кроме букв, цифр, «_», «.» и «-», превращается в дефис; дефисы
/// не повторяются и не стоят по краям; не длиннее 64 знаков.
pub fn normalize(out: *[max_len]u8, text: []const u8) []const u8 {
    var n: usize = 0;
    var count: usize = 0;
    var dash = false; // перед следующим знаком нужен дефис
    var view = std.unicode.Utf8View.init(text) catch return "";
    var it = view.iterator();
    while (it.nextCodepoint()) |cp_in| {
        const cp = lower(cp_in);
        const keep = switch (cp) {
            'a'...'z', '0'...'9', '_', '.' => true,
            '-' => false,
            else => cp >= 0x80 and isWordChar(cp),
        };
        if (!keep) {
            dash = n > 0;
            continue;
        }
        // Страница обрезает до 64 знаков последней: дефис может оказаться в конце.
        if (count >= 64) break;
        if (dash) {
            out[n] = '-';
            n += 1;
            count += 1;
            dash = false;
            if (count >= 64) break;
        }
        n += std.unicode.utf8Encode(cp, out[n..]) catch break;
        count += if (cp > 0xFFFF) 2 else 1; // страница режет по единицам UTF-16
    }
    return out[0..n];
}

fn lower(cp: u21) u21 {
    return switch (cp) {
        'A'...'Z' => cp + 0x20,
        0xC0...0xD6, 0xD8...0xDE => cp + 0x20, // Latin-1
        0x410...0x42F => cp + 0x20, // А…Я
        0x400...0x40F => cp + 0x50, // Ѐ…Џ, среди них Ё
        else => cp,
    };
}

/// Буквы и цифры вне ASCII: без таблиц Юникода считаем ими всё, кроме пробелов и знаков.
fn isWordChar(cp: u21) bool {
    return switch (cp) {
        0x80...0xBF, 0xD7, 0xF7 => false, // управляющие, знаки Latin-1, × и ÷
        0x2000...0x206F, 0x2E00...0x2E7F, 0x3000...0x303F => false, // пробелы и пунктуация
        0xFE00...0xFE0F, 0xFEFF => false,
        else => true,
    };
}

test "room: код, как его нормализует страница" {
    var buf: [max_len]u8 = undefined;
    try std.testing.expectEqualStrings("планёрка-12", normalize(&buf, "Планёрка 12"));
    try std.testing.expectEqualStrings("abc-def", normalize(&buf, "  ABC -- def!! "));
    try std.testing.expectEqualStrings("a_b.c", normalize(&buf, "a_b.c"));
    try std.testing.expectEqualStrings("ёлка", normalize(&buf, "ЁЛКА"));
    try std.testing.expectEqualStrings("", normalize(&buf, " -- "));
    try std.testing.expectEqualStrings("", normalize(&buf, "\xff\xfe"));
    const long: [100]u8 = @splat('x');
    try std.testing.expectEqual(@as(usize, 64), normalize(&buf, &long).len);
}

test "room: код из ссылки" {
    var buf: [max_len]u8 = undefined;
    try std.testing.expectEqualStrings("k3v9x2m7q1w8e5r4", parse(&buf, "https://anods.github.io/Zvonilka/#k3v9x2m7q1w8e5r4"));
    try std.testing.expectEqualStrings("планёрка-12", parse(&buf, "http://localhost:8080/?name=x#%D0%BF%D0%BB%D0%B0%D0%BD%D1%91%D1%80%D0%BA%D0%B0-12"));
    try std.testing.expectEqualStrings("tgroom_1", parse(&buf, "https://t.me/StartNewCallBot?startapp=tgroom_1"));
    try std.testing.expectEqualStrings("планёрка", parse(&buf, "https://t.me/StartNewCallBot?startapp=Xd0bfd0bbd0b0d0bdd191d180d0bad0b0"));
    try std.testing.expectEqualStrings("old-room", parse(&buf, "https://example.org/room/Old%20Room?x=1"));
    try std.testing.expectEqualStrings("test-abc123", parse(&buf, "test-abc123"));
    try std.testing.expectEqualStrings("", parse(&buf, "https://example.org/"));
}
