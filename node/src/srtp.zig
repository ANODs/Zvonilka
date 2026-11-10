//! SRTP и SRTCP (RFC 3711) для DTLS-SRTP (RFC 5764): защита и проверка пакетов RTP и RTCP.
//! Два профиля: AES_CM_128_HMAC_SHA1_80 и AEAD_AES_128_GCM (RFC 7714). Мастер-ключ и соль
//! даёт рукопожатие DTLS (dtls.zig), ключи сеанса выводятся из них здесь.
//!
//! `Context` — одно направление: либо то, что шлёт браузер, либо то, что шлёт узел.
//! Узел пересылает чужие пакеты с их номерами, поэтому и при отправке индекс пакета
//! оценивается по номеру, как у получателя, а не считается подряд.
//! Чистая логика над байтами: без сокетов и без часов.
const std = @import("std");
const crypto = std.crypto;
const rtp = @import("rtp.zig");
const Aes128 = crypto.core.aes.Aes128;
const AesCtx = crypto.core.aes.AesEncryptCtx(Aes128);
const HmacSha1 = crypto.auth.hmac.HmacSha1;
const Aes128Gcm = crypto.aead.aes_gcm.Aes128Gcm;
const ctr = crypto.core.modes.ctr;

/// Профили защиты из расширения use_srtp (RFC 5764, RFC 7714); значение — номер в реестре IANA.
pub const Profile = enum(u16) {
    aes128_cm_sha1_80 = 0x0001,
    aead_aes128_gcm = 0x0007,

    pub const key_len = 16;

    pub fn saltLen(p: Profile) usize {
        return switch (p) {
            .aes128_cm_sha1_80 => 14,
            .aead_aes128_gcm => 12,
        };
    }

    /// Сколько байт из вывода ключей DTLS нужно: по ключу и соли на каждую сторону.
    pub fn materialLen(p: Profile) usize {
        return 2 * (key_len + p.saltLen());
    }

    /// На сколько защита удлиняет пакет RTP: метка подлинности.
    pub fn rtpOverhead(p: Profile) usize {
        return switch (p) {
            .aes128_cm_sha1_80 => 10,
            .aead_aes128_gcm => 16,
        };
    }

    /// На сколько защита удлиняет пакет RTCP: метка и слово с индексом.
    pub fn rtcpOverhead(p: Profile) usize {
        return p.rtpOverhead() + 4;
    }

    /// Имя профиля в реестре IANA — так его называет и браузер.
    pub fn name(p: Profile) []const u8 {
        return switch (p) {
            .aes128_cm_sha1_80 => "SRTP_AES128_CM_HMAC_SHA1_80",
            .aead_aes128_gcm => "SRTP_AEAD_AES_128_GCM",
        };
    }
};

/// Самая длинная добавка к пакету среди профилей: столько места держат после пакета.
pub const max_overhead = 20;

pub const Error = error{
    /// Пакет короче заголовка и метки или заголовок испорчен.
    Malformed,
    /// Метка подлинности не сошлась: пакет чужой или испорчен.
    BadAuth,
    /// Такой пакет уже был, или он слишком старый, чтобы это проверить.
    Replay,
    /// В буфере нет места для метки.
    NoRoom,
};

// ---------------------------------------------------------------------------
// Ключи сеанса (RFC 3711, раздел 4.3): AES-CM как генератор, метка в седьмом байте соли.

fn kdf(out: []u8, master_key: [16]u8, master_salt: [14]u8, label: u8) void {
    var iv: [16]u8 = @splat(0);
    @memcpy(iv[0..14], &master_salt);
    iv[7] ^= label;
    @memset(out, 0);
    ctr(AesCtx, Aes128.initEnc(master_key), out, out, iv, .big);
}

const Keys = struct {
    enc: [16]u8,
    aes: AesCtx,
    /// HMAC-SHA1 с уже вложенным ключом: на пакет остаётся только сам пакет.
    auth: HmacSha1,
    salt: [14]u8,

    fn derive(master_key: [16]u8, master_salt: [14]u8, first_label: u8) Keys {
        var k: Keys = undefined;
        kdf(&k.enc, master_key, master_salt, first_label);
        k.aes = Aes128.initEnc(k.enc);
        var auth_key: [20]u8 = undefined;
        kdf(&auth_key, master_key, master_salt, first_label + 1);
        k.auth = HmacSha1.init(&auth_key);
        crypto.secureZero(u8, &auth_key);
        kdf(&k.salt, master_key, master_salt, first_label + 2);
        return k;
    }
};

// ---------------------------------------------------------------------------
// Индекс пакета и окно повторов.

/// Старший принятый индекс и 127 перед ним.
const Window = struct {
    top: u64 = 0,
    /// Бит i: индекс top − i принят. 0 — ещё ничего.
    seen: u128 = 0,

    const span = 128;

    fn started(w: *const Window) bool {
        return w.seen != 0;
    }

    /// false — повтор или слишком старый.
    fn fresh(w: *const Window, index: u64) bool {
        if (w.seen == 0 or index > w.top) return true;
        const back = w.top - index;
        return back < span and (w.seen >> @intCast(back)) & 1 == 0;
    }

    /// Только для пакета, который оказался подлинным: поддельный окно не двигает.
    fn accept(w: *Window, index: u64) void {
        if (w.seen == 0) {
            w.top = index;
            w.seen = 1;
        } else if (index > w.top) {
            const ahead = index - w.top;
            w.seen = if (ahead >= span) 1 else (w.seen << @intCast(ahead)) | 1;
            w.top = index;
        } else if (w.top - index < span) {
            w.seen |= @as(u128, 1) << @intCast(w.top - index);
        }
    }
};

/// Индекс пакета RTP — счётчик оборотов (ROC) и номер — по номеру и старшему принятому
/// индексу (RFC 3711, раздел 3.3.1). Первый пакет потока начинает с ROC = 0.
fn estimateIndex(w: *const Window, seq: u16) u64 {
    if (!w.started()) return seq;
    const roc: u64 = w.top >> 16;
    const s_l: u16 = @truncate(w.top);
    var v = roc;
    if (s_l < 0x8000) {
        // Номер намного больше старшего: это опоздавший пакет прошлого оборота.
        if (seq > s_l and seq - s_l > 0x8000) v = roc -% 1;
    } else {
        if (s_l - 0x8000 > seq) v = roc + 1;
    }
    return ((v & 0xffff_ffff) << 16) | seq;
}

const Stream = struct {
    used: bool = false,
    ssrc: u32 = 0,
    win: Window = .{},
    /// Когда потоком пользовались в последний раз: вытесняется самый давний.
    stamp: u64 = 0,
};

const max_streams = 24;

const Streams = struct {
    items: [max_streams]Stream = @splat(.{}),
    clock: u64 = 0,

    fn find(s: *Streams, ssrc: u32) ?*Stream {
        for (&s.items) |*st| {
            if (st.used and st.ssrc == ssrc) {
                s.clock += 1;
                st.stamp = s.clock;
                return st;
            }
        }
        return null;
    }

    /// Новый поток на месте свободного или самого давнего.
    fn add(s: *Streams, ssrc: u32) *Stream {
        var pick: *Stream = &s.items[0];
        for (&s.items) |*st| {
            if (!st.used) {
                pick = st;
                break;
            }
            if (st.stamp < pick.stamp) pick = st;
        }
        s.clock += 1;
        pick.* = .{ .used = true, .ssrc = ssrc, .stamp = s.clock };
        return pick;
    }
};

// ---------------------------------------------------------------------------

pub const Context = struct {
    profile: Profile,
    rtp_keys: Keys,
    rtcp_keys: Keys,
    rtp_streams: Streams = .{},
    rtcp_streams: Streams = .{},
    /// Индекс следующего исходящего пакета SRTCP — общий для всех SSRC: в IV входит и SSRC.
    rtcp_index: u32 = 0,

    /// Настраивает направление на месте. `master_salt` — 14 байт у AES-CM и 12 у GCM
    /// (для вывода ключей дополняется нулями, RFC 7714, раздел 11).
    pub fn init(c: *Context, profile: Profile, master_key: [16]u8, master_salt: []const u8) void {
        std.debug.assert(master_salt.len == profile.saltLen());
        var salt: [14]u8 = @splat(0);
        @memcpy(salt[0..master_salt.len], master_salt);
        c.* = .{
            .profile = profile,
            .rtp_keys = .derive(master_key, salt, 0),
            .rtcp_keys = .derive(master_key, salt, 3),
        };
        crypto.secureZero(u8, &salt);
    }

    // ------------------------------------------------------------------ RTP

    /// Защищает пакет RTP на месте: `buf[0..len]` — пакет, после него нужно место под метку.
    /// Возвращает новую длину.
    pub fn protectRtp(c: *Context, buf: []u8, len: usize) Error!usize {
        const header_len = rtp.headerLen(buf[0..len]) orelse return error.Malformed;
        const overhead = c.profile.rtpOverhead();
        if (len + overhead > buf.len) return error.NoRoom;
        const seq = std.mem.readInt(u16, buf[2..4], .big);
        const ssrc = std.mem.readInt(u32, buf[8..12], .big);
        const st = c.rtp_streams.find(ssrc) orelse c.rtp_streams.add(ssrc);
        const index = estimateIndex(&st.win, seq);
        if (!st.win.started() or index > st.win.top) st.win.accept(index);
        const payload = buf[header_len..len];
        switch (c.profile) {
            .aes128_cm_sha1_80 => {
                ctr(AesCtx, c.rtp_keys.aes, payload, payload, cmIv(&c.rtp_keys.salt, ssrc, index), .big);
                var roc: [4]u8 = undefined;
                std.mem.writeInt(u32, &roc, @truncate(index >> 16), .big);
                var h = c.rtp_keys.auth;
                h.update(buf[0..len]);
                h.update(&roc);
                var mac: [HmacSha1.mac_length]u8 = undefined;
                h.final(&mac);
                @memcpy(buf[len..][0..10], mac[0..10]);
            },
            .aead_aes128_gcm => {
                var tag: [16]u8 = undefined;
                Aes128Gcm.encrypt(payload, &tag, payload, buf[0..header_len], gcmRtpIv(&c.rtp_keys.salt, ssrc, index), c.rtp_keys.enc);
                @memcpy(buf[len..][0..16], &tag);
            },
        }
        return len + overhead;
    }

    /// Проверяет и расшифровывает пакет SRTP на месте; возвращает пакет RTP.
    pub fn unprotectRtp(c: *Context, packet: []u8) Error![]u8 {
        const overhead = c.profile.rtpOverhead();
        if (packet.len < rtp.min_header + overhead) return error.Malformed;
        const len = packet.len - overhead;
        const header_len = rtp.headerLen(packet[0..len]) orelse return error.Malformed;
        const seq = std.mem.readInt(u16, packet[2..4], .big);
        const ssrc = std.mem.readInt(u32, packet[8..12], .big);
        // Поток заводится только подлинным пакетом: до проверки — временное пустое окно.
        var blank: Window = .{};
        const known = c.rtp_streams.find(ssrc);
        const win: *Window = if (known) |st| &st.win else &blank;
        const index = estimateIndex(win, seq);
        if (!win.fresh(index)) return error.Replay;
        const payload = packet[header_len..len];
        switch (c.profile) {
            .aes128_cm_sha1_80 => {
                var roc: [4]u8 = undefined;
                std.mem.writeInt(u32, &roc, @truncate(index >> 16), .big);
                var h = c.rtp_keys.auth;
                h.update(packet[0..len]);
                h.update(&roc);
                var mac: [HmacSha1.mac_length]u8 = undefined;
                h.final(&mac);
                if (!crypto.timing_safe.eql([10]u8, mac[0..10].*, packet[len..][0..10].*)) return error.BadAuth;
                ctr(AesCtx, c.rtp_keys.aes, payload, payload, cmIv(&c.rtp_keys.salt, ssrc, index), .big);
            },
            .aead_aes128_gcm => {
                const tag = packet[len..][0..16].*;
                Aes128Gcm.decrypt(payload, payload, tag, packet[0..header_len], gcmRtpIv(&c.rtp_keys.salt, ssrc, index), c.rtp_keys.enc) catch return error.BadAuth;
            },
        }
        const st = known orelse c.rtp_streams.add(ssrc);
        st.win.accept(index);
        return packet[0..len];
    }

    // ------------------------------------------------------------------ RTCP

    /// Защищает составной пакет RTCP на месте: `buf[0..len]` — пакет, после него нужно место
    /// под слово с индексом и метку. Возвращает новую длину.
    pub fn protectRtcp(c: *Context, buf: []u8, len: usize) Error!usize {
        if (len < 8) return error.Malformed;
        const overhead = c.profile.rtcpOverhead();
        if (len + overhead > buf.len) return error.NoRoom;
        const ssrc = std.mem.readInt(u32, buf[4..8], .big);
        c.rtcp_index = (c.rtcp_index + 1) & 0x7fff_ffff;
        const index = c.rtcp_index;
        var word: [4]u8 = undefined;
        std.mem.writeInt(u32, &word, 0x8000_0000 | index, .big); // старший бит: пакет зашифрован
        const body = buf[8..len];
        switch (c.profile) {
            .aes128_cm_sha1_80 => {
                ctr(AesCtx, c.rtcp_keys.aes, body, body, cmIv(&c.rtcp_keys.salt, ssrc, index), .big);
                @memcpy(buf[len..][0..4], &word);
                var h = c.rtcp_keys.auth;
                h.update(buf[0 .. len + 4]);
                var mac: [HmacSha1.mac_length]u8 = undefined;
                h.final(&mac);
                @memcpy(buf[len + 4 ..][0..10], mac[0..10]);
            },
            .aead_aes128_gcm => {
                // Связанные данные: первые восемь байт пакета и слово с индексом; слово идёт последним.
                var aad: [12]u8 = undefined;
                @memcpy(aad[0..8], buf[0..8]);
                @memcpy(aad[8..12], &word);
                var tag: [16]u8 = undefined;
                Aes128Gcm.encrypt(body, &tag, body, &aad, gcmRtcpIv(&c.rtcp_keys.salt, ssrc, index), c.rtcp_keys.enc);
                @memcpy(buf[len..][0..16], &tag);
                @memcpy(buf[len + 16 ..][0..4], &word);
            },
        }
        return len + overhead;
    }

    /// Проверяет и расшифровывает пакет SRTCP на месте; возвращает составной пакет RTCP.
    pub fn unprotectRtcp(c: *Context, packet: []u8) Error![]u8 {
        const overhead = c.profile.rtcpOverhead();
        if (packet.len < 8 + overhead) return error.Malformed;
        const len = packet.len - overhead;
        const ssrc = std.mem.readInt(u32, packet[4..8], .big);
        const word_at = switch (c.profile) {
            .aes128_cm_sha1_80 => len,
            .aead_aes128_gcm => len + 16,
        };
        const word = packet[word_at..][0..4].*;
        const raw = std.mem.readInt(u32, &word, .big);
        const encrypted = raw & 0x8000_0000 != 0;
        const index: u32 = raw & 0x7fff_ffff;
        var blank: Window = .{};
        const known = c.rtcp_streams.find(ssrc);
        const win: *Window = if (known) |st| &st.win else &blank;
        if (!win.fresh(index)) return error.Replay;
        const body = packet[8..len];
        switch (c.profile) {
            .aes128_cm_sha1_80 => {
                var h = c.rtcp_keys.auth;
                h.update(packet[0 .. len + 4]);
                var mac: [HmacSha1.mac_length]u8 = undefined;
                h.final(&mac);
                if (!crypto.timing_safe.eql([10]u8, mac[0..10].*, packet[len + 4 ..][0..10].*)) return error.BadAuth;
                if (encrypted) ctr(AesCtx, c.rtcp_keys.aes, body, body, cmIv(&c.rtcp_keys.salt, ssrc, index), .big);
            },
            .aead_aes128_gcm => {
                const tag = packet[len..][0..16].*;
                const iv = gcmRtcpIv(&c.rtcp_keys.salt, ssrc, index);
                if (encrypted) {
                    var aad: [12]u8 = undefined;
                    @memcpy(aad[0..8], packet[0..8]);
                    @memcpy(aad[8..12], &word);
                    Aes128Gcm.decrypt(body, body, tag, &aad, iv, c.rtcp_keys.enc) catch return error.BadAuth;
                } else {
                    // Без шифрования весь пакет — связанные данные, метка считается над пустым текстом.
                    var aad: [1500 + 4]u8 = undefined;
                    if (len + 4 > aad.len) return error.Malformed;
                    @memcpy(aad[0..len], packet[0..len]);
                    @memcpy(aad[len..][0..4], &word);
                    var none: [0]u8 = .{};
                    Aes128Gcm.decrypt(&none, &none, tag, aad[0 .. len + 4], iv, c.rtcp_keys.enc) catch return error.BadAuth;
                }
            },
        }
        const st = known orelse c.rtcp_streams.add(ssrc);
        st.win.accept(index);
        return packet[0..len];
    }
};

/// IV режима счётчика (RFC 3711, раздел 4.1.1): соль, SSRC и индекс пакета; младшие 16 бит —
/// счётчик блоков.
fn cmIv(salt: *const [14]u8, ssrc: u32, index: u64) [16]u8 {
    var iv: [16]u8 = @splat(0);
    @memcpy(iv[0..14], salt);
    var s: [4]u8 = undefined;
    std.mem.writeInt(u32, &s, ssrc, .big);
    for (iv[4..8], s) |*b, x| b.* ^= x;
    var i: [6]u8 = undefined;
    std.mem.writeInt(u48, &i, @truncate(index), .big);
    for (iv[8..14], i) |*b, x| b.* ^= x;
    return iv;
}

/// IV для GCM (RFC 7714, раздел 8.1): 00 00 ‖ SSRC ‖ ROC ‖ номер, сложенные с солью.
fn gcmRtpIv(salt: *const [14]u8, ssrc: u32, index: u64) [12]u8 {
    var iv: [12]u8 = @splat(0);
    std.mem.writeInt(u32, iv[2..6], ssrc, .big);
    std.mem.writeInt(u48, iv[6..12], @truncate(index), .big);
    for (&iv, salt[0..12]) |*b, x| b.* ^= x;
    return iv;
}

/// IV для GCM в SRTCP (RFC 7714, раздел 9.1): 00 00 ‖ SSRC ‖ 00 00 ‖ индекс, сложенные с солью.
fn gcmRtcpIv(salt: *const [14]u8, ssrc: u32, index: u32) [12]u8 {
    var iv: [12]u8 = @splat(0);
    std.mem.writeInt(u32, iv[2..6], ssrc, .big);
    std.mem.writeInt(u32, iv[8..12], index, .big);
    for (&iv, salt[0..12]) |*b, x| b.* ^= x;
    return iv;
}

// ---------------------------------------------------------------------------
// Тесты. Векторы — из RFC 3711 (приложения B.2 и B.3) и из набора тестов libsrtp
// (srtp_validate, srtp_validate_gcm: ключи те же, что в RFC); каждый сверен независимым
// расчётом на OpenSSL.

fn hexBytes(comptime s: []const u8) [s.len / 2]u8 {
    var out: [s.len / 2]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, s) catch unreachable;
    return out;
}

test "srtp: RFC 3711 B.2 — поток ключа AES-CM" {
    const key = hexBytes("2B7E151628AED2A6ABF7158809CF4F3C");
    const salt = hexBytes("F0F1F2F3F4F5F6F7F8F9FAFBFCFD");
    // SSRC 0, ROC 0, номер 0: IV — соль и нулевой счётчик блоков.
    const iv = cmIv(&salt, 0, 0);
    try std.testing.expectEqualSlices(u8, &hexBytes("F0F1F2F3F4F5F6F7F8F9FAFBFCFD0000"), &iv);
    var stream: [48]u8 = @splat(0);
    ctr(AesCtx, Aes128.initEnc(key), &stream, &stream, iv, .big);
    try std.testing.expectEqualSlices(u8, &hexBytes("E03EAD0935C95E80E166B16DD92B4EB4" ++
        "D23513162B02D0F72A43A2FE4A5F97AB" ++
        "41E95B3BB0A2E8DD477901E4FCA894C0"), &stream);
    // Блоки FEFF, FF00, FF01: счётчик переходит через байт.
    var tail_iv = iv;
    tail_iv[14] = 0xFE;
    tail_iv[15] = 0xFF;
    ctr(AesCtx, Aes128.initEnc(key), &stream, &@as([48]u8, @splat(0)), tail_iv, .big);
    try std.testing.expectEqualSlices(u8, &hexBytes("EC8CDF7398607CB0F2D21675EA9EA1E4" ++
        "362B7C3C6773516318A077D7FC5073AE" ++
        "6A2CC3787889374FBEB4C81B17BA6C44"), &stream);
}

const rfc_key = hexBytes("E1F97A0D3E018BE0D64FA32C06DE4139");
const rfc_salt = hexBytes("0EC675AD498AFEEBB6960B3AABE6");

test "srtp: RFC 3711 B.3 — вывод ключей сеанса" {
    var enc: [16]u8 = undefined;
    kdf(&enc, rfc_key, rfc_salt, 0);
    try std.testing.expectEqualSlices(u8, &hexBytes("C61E7A93744F39EE10734AFE3FF7A087"), &enc);
    var salt: [14]u8 = undefined;
    kdf(&salt, rfc_key, rfc_salt, 2);
    try std.testing.expectEqualSlices(u8, &hexBytes("30CBBC08863D8C85D49DB34A9AE1"), &salt);
    var auth: [94]u8 = undefined;
    kdf(&auth, rfc_key, rfc_salt, 1);
    try std.testing.expectEqualSlices(u8, &hexBytes("CEBE321F6FF7716B6FD4AB49AF256A15" ++
        "6D38BAA48F0A0ACF3C34E2359E6CDBCE" ++
        "E049646C43D9327AD175578EF7227098" ++
        "6371C10C9A369AC2F94A8C5FBCDDDC25" ++
        "6D6E919A48B610EF17C2041E47403576" ++
        "6B68642C59BBFC2F34DB60DBDFB2"), &auth);
    // Ключи SRTCP — метки 3, 4, 5 (в RFC их нет; сверено с OpenSSL).
    kdf(&enc, rfc_key, rfc_salt, 3);
    try std.testing.expectEqualSlices(u8, &hexBytes("4C1AA45A81F73D61C800BBB00FBB1EAA"), &enc);
    var auth_c: [20]u8 = undefined;
    kdf(&auth_c, rfc_key, rfc_salt, 4);
    try std.testing.expectEqualSlices(u8, &hexBytes("8D54534FEB49AE8E7993A6BD0B844FC323A93DFD"), &auth_c);
    kdf(&salt, rfc_key, rfc_salt, 5);
    try std.testing.expectEqualSlices(u8, &hexBytes("9581C7AD87B3E530BF3E4454A8B3"), &salt);
}

const plain_rtp = hexBytes("800f1234decafbadcafebabe" ++ "abababababababababababababababab");
const plain_rtcp = hexBytes("81c8000bcafebabe" ++ "abababababababababababababababab");

test "srtp: AES_CM_128_HMAC_SHA1_80 — пакеты из тестов libsrtp" {
    var tx: Context = undefined;
    tx.init(.aes128_cm_sha1_80, rfc_key, &rfc_salt);
    var rx: Context = undefined;
    rx.init(.aes128_cm_sha1_80, rfc_key, &rfc_salt);

    var buf: [64]u8 = undefined;
    @memcpy(buf[0..plain_rtp.len], &plain_rtp);
    const n = try tx.protectRtp(&buf, plain_rtp.len);
    try std.testing.expectEqualSlices(u8, &hexBytes("800f1234decafbadcafebabe" ++
        "4e55dc4ce79978d88ca4d215949d2402" ++ "b78d6acc99ea179b8dbb"), buf[0..n]);
    try std.testing.expectEqualSlices(u8, &plain_rtp, try rx.unprotectRtp(buf[0..n]));

    @memcpy(buf[0..plain_rtcp.len], &plain_rtcp);
    const m = try tx.protectRtcp(&buf, plain_rtcp.len);
    try std.testing.expectEqualSlices(u8, &hexBytes("81c8000bcafebabe" ++
        "7128035be487b9bdbef89041f977a5a8" ++ "80000001" ++ "993e08cd54d6c1230798"), buf[0..m]);
    try std.testing.expectEqualSlices(u8, &plain_rtcp, try rx.unprotectRtcp(buf[0..m]));
}

const gcm_key = hexBytes("000102030405060708090a0b0c0d0e0f");
const gcm_salt = hexBytes("a0a1a2a3a4a5a6a7a8a9aaab");

test "srtp: AEAD_AES_128_GCM — пакеты из тестов libsrtp" {
    var tx: Context = undefined;
    tx.init(.aead_aes128_gcm, gcm_key, &gcm_salt);
    var rx: Context = undefined;
    rx.init(.aead_aes128_gcm, gcm_key, &gcm_salt);

    var buf: [64]u8 = undefined;
    @memcpy(buf[0..plain_rtp.len], &plain_rtp);
    const n = try tx.protectRtp(&buf, plain_rtp.len);
    try std.testing.expectEqualSlices(u8, &hexBytes("800f1234decafbadcafebabe" ++
        "c5002ede04cfdd2eb91159e0880aa06e" ++ "d2976826f796b201df3131a127e8a392"), buf[0..n]);
    try std.testing.expectEqualSlices(u8, &plain_rtp, try rx.unprotectRtp(buf[0..n]));

    @memcpy(buf[0..plain_rtcp.len], &plain_rtcp);
    const m = try tx.protectRtcp(&buf, plain_rtcp.len);
    try std.testing.expectEqualSlices(u8, &hexBytes("81c8000bcafebabe" ++
        "c98b8b5df0392a55852b6c21ac8e7025" ++ "c52c6fbea2b3b446ea31123ba88ce61e" ++ "80000001"), buf[0..m]);
    try std.testing.expectEqualSlices(u8, &plain_rtcp, try rx.unprotectRtcp(buf[0..m]));
}

// Эталон посчитан отдельно на OpenSSL: тот же пакет с номером 1 на втором круге номеров.
test "srtp: второй круг номеров (ROC = 1) совпадает с независимым расчётом" {
    const cases = [_]struct { profile: Profile, key: [16]u8, salt: []const u8, want: []const u8 }{
        .{ .profile = .aes128_cm_sha1_80, .key = rfc_key, .salt = &rfc_salt, .want = &hexBytes("800f0001decafbadcafebabe" ++
            "b6f1f0a458a238ac3d2f55ac6566b25c" ++ "051f89495037505c44c7") },
        .{ .profile = .aead_aes128_gcm, .key = gcm_key, .salt = &gcm_salt, .want = &hexBytes("800f0001decafbadcafebabe" ++
            "ed15014db6b05349ed97792f4c31d438" ++ "d58ed625fb433cf3516c086320a405dc") },
    };
    for (cases) |c| {
        var tx: Context = undefined;
        tx.init(c.profile, c.key, c.salt);
        var rx: Context = undefined;
        rx.init(c.profile, c.key, c.salt);
        var buf: [64]u8 = undefined;
        // Пакет с номером 65535 заканчивает первый круг у обеих сторон.
        var plain = plain_rtp;
        std.mem.writeInt(u16, plain[2..4], 0xffff, .big);
        @memcpy(buf[0..plain.len], &plain);
        var n = try tx.protectRtp(&buf, plain.len);
        _ = try rx.unprotectRtp(buf[0..n]);
        // Номер 1 — уже второй круг.
        std.mem.writeInt(u16, plain[2..4], 1, .big);
        @memcpy(buf[0..plain.len], &plain);
        n = try tx.protectRtp(&buf, plain.len);
        try std.testing.expectEqualSlices(u8, c.want, buf[0..n]);
        try std.testing.expectEqualSlices(u8, &plain, try rx.unprotectRtp(buf[0..n]));
    }
}

fn testPacket(buf: []u8, seq: u16, ssrc: u32, payload: []const u8) usize {
    buf[0] = 0x80;
    buf[1] = 96;
    std.mem.writeInt(u16, buf[2..4], seq, .big);
    std.mem.writeInt(u32, buf[4..8], 1000, .big);
    std.mem.writeInt(u32, buf[8..12], ssrc, .big);
    @memcpy(buf[12..][0..payload.len], payload);
    return 12 + payload.len;
}

test "srtp: подделка, повтор и оборот номера" {
    inline for (.{ Profile.aes128_cm_sha1_80, Profile.aead_aes128_gcm }) |profile| {
        const salt = if (profile == .aes128_cm_sha1_80) &rfc_salt else &gcm_salt;
        var tx: Context = undefined;
        tx.init(profile, rfc_key, salt);
        var rx: Context = undefined;
        rx.init(profile, rfc_key, salt);
        var other: Context = undefined;
        other.init(profile, gcm_key, salt);

        var buf: [128]u8 = undefined;
        var copy: [128]u8 = undefined;
        var n = try tx.protectRtp(&buf, testPacket(&buf, 65534, 7, "раз"));
        @memcpy(copy[0..n], buf[0..n]);
        try std.testing.expectEqualStrings("раз", (try rx.unprotectRtp(buf[0..n]))[12..]);
        // Тот же пакет ещё раз — повтор; с испорченным байтом или чужим ключом — подделка.
        @memcpy(buf[0..n], copy[0..n]);
        try std.testing.expectError(error.Replay, rx.unprotectRtp(buf[0..n]));
        n = try tx.protectRtp(&buf, testPacket(&buf, 65535, 7, "два"));
        @memcpy(copy[0..n], buf[0..n]);
        buf[14] ^= 1;
        try std.testing.expectError(error.BadAuth, rx.unprotectRtp(buf[0..n]));
        @memcpy(buf[0..n], copy[0..n]);
        try std.testing.expectError(error.BadAuth, other.unprotectRtp(buf[0..n]));
        // Неиспорченным он всё ещё проходит: подделка окно не сдвинула.
        @memcpy(buf[0..n], copy[0..n]);
        try std.testing.expectEqualStrings("два", (try rx.unprotectRtp(buf[0..n]))[12..]);

        // Номер пошёл на новый оборот: 0 и 1 идут с ROC = 1, и получатель это видит сам.
        n = try tx.protectRtp(&buf, testPacket(&buf, 1, 7, "четыре"));
        var late: [128]u8 = undefined;
        @memcpy(late[0..n], buf[0..n]);
        const late_len = n;
        n = try tx.protectRtp(&buf, testPacket(&buf, 0, 7, "три"));
        try std.testing.expectEqualStrings("три", (try rx.unprotectRtp(buf[0..n]))[12..]);
        try std.testing.expectEqualStrings("четыре", (try rx.unprotectRtp(late[0..late_len]))[12..]);
        try std.testing.expectEqual(@as(u64, 0x1_0001), rx.rtp_streams.find(7).?.win.top);
        // Другой SSRC начинает свой счёт.
        n = try tx.protectRtp(&buf, testPacket(&buf, 500, 8, "другой поток"));
        try std.testing.expectEqualStrings("другой поток", (try rx.unprotectRtp(buf[0..n]))[12..]);
        try std.testing.expectEqual(@as(u64, 500), rx.rtp_streams.find(8).?.win.top);

        // RTCP: индекс растёт, повтор отбрасывается, подделка тоже.
        @memcpy(buf[0..plain_rtcp.len], &plain_rtcp);
        n = try tx.protectRtcp(&buf, plain_rtcp.len);
        @memcpy(copy[0..n], buf[0..n]);
        try std.testing.expectEqualSlices(u8, &plain_rtcp, try rx.unprotectRtcp(buf[0..n]));
        @memcpy(buf[0..n], copy[0..n]);
        try std.testing.expectError(error.Replay, rx.unprotectRtcp(buf[0..n]));
        @memcpy(buf[0..plain_rtcp.len], &plain_rtcp);
        n = try tx.protectRtcp(&buf, plain_rtcp.len);
        buf[9] ^= 0x40;
        try std.testing.expectError(error.BadAuth, rx.unprotectRtcp(buf[0..n]));
        try std.testing.expectEqual(@as(u32, 2), tx.rtcp_index);

        // Слишком короткое и без места под метку.
        try std.testing.expectError(error.Malformed, rx.unprotectRtp(buf[0..12]));
        try std.testing.expectError(error.Malformed, rx.unprotectRtcp(buf[0..10]));
        var tight: [24]u8 = undefined;
        try std.testing.expectError(error.NoRoom, tx.protectRtp(&tight, testPacket(&tight, 9, 7, "тесно")));
    }
}

test "srtp: оценка индекса по номеру" {
    var w: Window = .{};
    try std.testing.expectEqual(@as(u64, 40000), estimateIndex(&w, 40000)); // первый пакет: ROC = 0
    w.accept(40000);
    try std.testing.expectEqual(@as(u64, 39990), estimateIndex(&w, 39990)); // чуть опоздал
    try std.testing.expectEqual(@as(u64, 0x1_0005), estimateIndex(&w, 5)); // оборот вперёд
    w.accept(0x1_0005);
    try std.testing.expectEqual(@as(u64, 65530), estimateIndex(&w, 65530)); // опоздал из прошлого оборота
    try std.testing.expectEqual(@as(u64, 0x1_7000), estimateIndex(&w, 0x7000));
    // До первого оборота «прошлого оборота» нет: такой индекс не пройдёт проверку подлинности.
    var z: Window = .{};
    z.accept(3);
    try std.testing.expectEqual(@as(u64, 0xffff_ffff_fff0), estimateIndex(&z, 0xfff0));
    // Окно: 127 назад ещё различимо, 128 — уже нет.
    var r: Window = .{};
    r.accept(1000);
    try std.testing.expect(r.fresh(873));
    try std.testing.expect(!r.fresh(872));
    try std.testing.expect(!r.fresh(1000));
    r.accept(873);
    try std.testing.expect(!r.fresh(873));
    r.accept(1200);
    try std.testing.expect(!r.fresh(1000));
    try std.testing.expect(r.fresh(1199));
}
