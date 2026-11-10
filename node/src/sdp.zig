//! SDP (RFC 8866, RFC 8829) для соединения с браузером: разбор его offer и сборка answer узла.
//! В offer страницы пять секций: микрофон, камера, экран, звук экрана и канал данных.
//!
//! Узел пересылает медиа между плечами как есть, поэтому на каждом плече соглашается только
//! на то, что умеет любой браузер: Opus для звука, VP8 с повторами (rtx) для видео. Так у двух
//! плеч всегда один кодек, и узлу остаётся перевести номера: тип нагрузки, SSRC, расширения.
const std = @import("std");
const net = std.Io.net;

pub const max_media = 8;
pub const max_ext = 12;
pub const max_candidates = 16;
/// Название секции (MID) длиннее этого узел не берёт: браузеры называют секции числами.
pub const max_mid = 32;

pub const Setup = enum { actpass, active, passive };

pub const Kind = enum {
    audio,
    video,
    application,
    other,
};

pub const Direction = enum {
    sendrecv,
    sendonly,
    recvonly,
    inactive,

    /// Направление секции в ответе: что один шлёт, другой принимает.
    pub fn reverse(d: Direction) Direction {
        return switch (d) {
            .sendrecv => .sendrecv,
            .sendonly => .recvonly,
            .recvonly => .sendonly,
            .inactive => .inactive,
        };
    }

    /// Шлёт ли в такой секции тот, кто её написал.
    pub fn sends(d: Direction) bool {
        return d == .sendrecv or d == .sendonly;
    }
};

/// Расширения заголовка RTP, которые узел пропускает между плечами; остальные в ответ не идут,
/// и браузер их не шлёт.
pub const Ext = enum {
    mid,
    audio_level,
    abs_send_time,
    transport_cc,
    video_orientation,
    playout_delay,
    video_content_type,
    video_timing,
    color_space,

    pub fn uri(e: Ext) []const u8 {
        return switch (e) {
            .mid => "urn:ietf:params:rtp-hdrext:sdes:mid",
            .audio_level => "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
            .abs_send_time => "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
            .transport_cc => "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
            .video_orientation => "urn:3gpp:video-orientation",
            .playout_delay => "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
            .video_content_type => "http://www.webrtc.org/experiments/rtp-hdrext/video-content-type",
            .video_timing => "http://www.webrtc.org/experiments/rtp-hdrext/video-timing",
            .color_space => "http://www.webrtc.org/experiments/rtp-hdrext/color-space",
        };
    }

    pub fn fromUri(s: []const u8) ?Ext {
        for (std.meta.tags(Ext)) |e| {
            if (std.mem.eql(u8, s, e.uri())) return e;
        }
        return null;
    }
};

pub const ExtEntry = struct { id: u8, ext: Ext };

/// Обратная связь RTCP, о которой договорились для кодека секции.
pub const Feedback = struct {
    transport_cc: bool = false,
    remb: bool = false,
    fir: bool = false,
    nack: bool = false,
    pli: bool = false,
};

/// Одна секция «m=». Срезы указывают в текст SDP.
pub const Media = struct {
    kind: Kind,
    /// Как секция записана в offer: при отказе её нужно повторить.
    kind_text: []const u8,
    proto: []const u8,
    first_fmt: []const u8,
    /// Порт 0: отправитель сам от секции отказался.
    port_zero: bool,
    mid: []const u8 = "",
    direction: Direction = .sendrecv,

    // Медиа.
    /// Тип нагрузки кодека, на который согласен узел: Opus или VP8.
    pt: ?u7 = null,
    /// Тип нагрузки повторов (rtx) этого кодека.
    rtx_pt: ?u7 = null,
    fmtp: []const u8 = "",
    feedback: Feedback = .{},
    rtcp_mux: bool = false,
    rtcp_rsize: bool = false,
    /// Значение a=rtcp-xr, если есть.
    rtcp_xr: []const u8 = "",
    ext: [max_ext]ExtEntry = undefined,
    ext_count: usize = 0,
    /// Чем шлёт автор описания: основной поток и поток повторов; 0 — не объявлен.
    ssrc: u32 = 0,
    rtx_ssrc: u32 = 0,
    /// Группа синхронизации из a=msid: у микрофона и камеры она общая.
    stream: []const u8 = "",

    // Канал данных.
    datachannel: bool = false,
    sctp_port: u16 = 5000,
    max_message_size: u32 = 65536,

    pub fn isRtp(m: *const Media) bool {
        return m.kind == .audio or m.kind == .video;
    }

    /// Секцию узел принимает: канал данных или медиа с кодеком, который он пересылает.
    pub fn accepted(m: *const Media) bool {
        if (m.port_zero) return false;
        if (m.kind == .application) return m.datachannel;
        return m.isRtp() and m.pt != null and m.rtcp_mux and m.mid.len > 0 and m.mid.len <= max_mid;
    }

    pub fn extensions(m: *const Media) []const ExtEntry {
        return m.ext[0..m.ext_count];
    }

    pub fn extId(m: *const Media, e: Ext) u8 {
        for (m.extensions()) |x| if (x.ext == e) return x.id;
        return 0;
    }
};

pub const Offer = struct {
    /// Номер сеанса из строки «o=»: у нового соединения он другой, у пересогласования — тот же.
    session_id: []const u8 = "",
    ufrag: []const u8 = "",
    pwd: []const u8 = "",
    /// SHA-256 сертификата DTLS браузера.
    fingerprint: [32]u8 = undefined,
    setup: Setup = .actpass,
    allow_mixed: bool = false,
    media: [max_media]Media = undefined,
    media_count: usize = 0,
    candidates: [max_candidates]net.IpAddress = undefined,
    candidate_count: usize = 0,

    pub fn sections(o: *const Offer) []const Media {
        return o.media[0..o.media_count];
    }

    fn addCandidate(o: *Offer, addr: net.IpAddress) void {
        for (o.candidates[0..o.candidate_count]) |*c| if (c.eql(&addr)) return;
        if (o.candidate_count == max_candidates) return;
        o.candidates[o.candidate_count] = addr;
        o.candidate_count += 1;
    }
};

pub const Error = error{ NoMedia, TooManySections, NoIceCredentials, NoFingerprint, DtlsRoleUnsupported };

fn lineIterator(text: []const u8) std.mem.SplitIterator(u8, .scalar) {
    return std.mem.splitScalar(u8, text, '\n');
}

fn attr(line: []const u8, comptime name: []const u8) ?[]const u8 {
    const prefix = "a=" ++ name ++ ":";
    if (!std.mem.startsWith(u8, line, prefix)) return null;
    return std.mem.trim(u8, line[prefix.len..], " \t");
}

/// «96 VP8/90000» → 96 и «VP8/90000»; номер должен быть типом нагрузки.
fn ptAndRest(v: []const u8) ?struct { u7, []const u8 } {
    const sp = std.mem.findScalar(u8, v, ' ') orelse return null;
    const pt = std.fmt.parseInt(u7, v[0..sp], 10) catch return null;
    return .{ pt, std.mem.trim(u8, v[sp + 1 ..], " \t") };
}

pub fn parseOffer(text: []const u8) Error!Offer {
    var o: Offer = .{};
    var ufrag: ?[]const u8 = null;
    var pwd: ?[]const u8 = null;
    var fingerprint: ?[32]u8 = null;
    var setup: ?Setup = null;
    var cur: ?*Media = null;
    var body_start: usize = 0; // где начались строки текущей секции

    var pos: usize = 0;
    while (pos < text.len) {
        const end = std.mem.findScalarPos(u8, text, pos, '\n') orelse text.len;
        const line = std.mem.trimEnd(u8, text[pos..end], "\r");
        const line_start = pos;
        pos = @min(end + 1, text.len);

        if (std.mem.startsWith(u8, line, "m=")) {
            if (cur) |m| resolveCodec(m, text[body_start..line_start]);
            if (o.media_count == max_media) return error.TooManySections;
            var f = std.mem.tokenizeScalar(u8, line[2..], ' ');
            const kind_text = f.next() orelse "";
            const port = f.next() orelse "";
            const proto = f.next() orelse "";
            const first_fmt = f.next() orelse "";
            const kind: Kind = if (std.mem.eql(u8, kind_text, "audio")) .audio else if (std.mem.eql(u8, kind_text, "video")) .video else if (std.mem.eql(u8, kind_text, "application")) .application else .other;
            o.media[o.media_count] = .{
                .kind = kind,
                .kind_text = kind_text,
                .proto = proto,
                .first_fmt = first_fmt,
                .port_zero = std.mem.eql(u8, port, "0"),
                .datachannel = kind == .application and std.mem.find(u8, proto, "SCTP") != null and std.mem.eql(u8, first_fmt, "webrtc-datachannel"),
            };
            cur = &o.media[o.media_count];
            o.media_count += 1;
            body_start = pos;
            continue;
        }
        if (std.mem.startsWith(u8, line, "o=")) {
            var f = std.mem.tokenizeScalar(u8, line[2..], ' ');
            _ = f.next();
            o.session_id = f.next() orelse "";
            continue;
        }
        // ICE и DTLS — на уровне сеанса (Firefox) или в секциях (Chrome); все секции идут одним
        // транспортом, так что берём первое встреченное.
        if (attr(line, "ice-ufrag")) |v| ufrag = ufrag orelse v;
        if (attr(line, "ice-pwd")) |v| pwd = pwd orelse v;
        if (attr(line, "fingerprint")) |v| {
            if (fingerprint == null) fingerprint = parseFingerprint(v);
        }
        if (attr(line, "setup")) |v| {
            if (setup == null) setup = if (std.mem.eql(u8, v, "active")) .active else if (std.mem.eql(u8, v, "passive")) .passive else .actpass;
        }
        if (attr(line, "candidate")) |v| {
            if (parseCandidate(v)) |c| o.addCandidate(c);
        }
        const m = cur orelse {
            if (std.mem.eql(u8, line, "a=extmap-allow-mixed")) o.allow_mixed = true;
            continue;
        };
        if (attr(line, "mid")) |v| m.mid = v;
        if (std.mem.eql(u8, line, "a=sendrecv")) m.direction = .sendrecv;
        if (std.mem.eql(u8, line, "a=sendonly")) m.direction = .sendonly;
        if (std.mem.eql(u8, line, "a=recvonly")) m.direction = .recvonly;
        if (std.mem.eql(u8, line, "a=inactive")) m.direction = .inactive;
        if (std.mem.eql(u8, line, "a=rtcp-mux")) m.rtcp_mux = true;
        if (std.mem.eql(u8, line, "a=rtcp-rsize")) m.rtcp_rsize = true;
        if (attr(line, "rtcp-xr")) |v| m.rtcp_xr = v;
        if (attr(line, "sctp-port")) |v| m.sctp_port = std.fmt.parseInt(u16, v, 10) catch 5000;
        if (attr(line, "max-message-size")) |v| m.max_message_size = std.fmt.parseInt(u32, v, 10) catch 65536;
        if (attr(line, "msid")) |v| {
            var f = std.mem.tokenizeScalar(u8, v, ' ');
            const stream = f.next() orelse "";
            if (m.stream.len == 0 and !std.mem.eql(u8, stream, "-")) m.stream = stream;
        }
        if (attr(line, "extmap")) |v| addExt(m, v);
        if (attr(line, "ssrc-group")) |v| {
            // «FID основной повторы»: пара потоков одной дорожки.
            var f = std.mem.tokenizeScalar(u8, v, ' ');
            if (std.mem.eql(u8, f.next() orelse "", "FID")) {
                const a = std.fmt.parseInt(u32, f.next() orelse "", 10) catch 0;
                const b = std.fmt.parseInt(u32, f.next() orelse "", 10) catch 0;
                if (a != 0 and b != 0) {
                    m.ssrc = a;
                    m.rtx_ssrc = b;
                }
            }
        }
        if (attr(line, "ssrc")) |v| {
            const sp = std.mem.findScalar(u8, v, ' ') orelse v.len;
            const n = std.fmt.parseInt(u32, v[0..sp], 10) catch 0;
            if (m.ssrc == 0) m.ssrc = n;
        }
    }
    if (cur) |m| resolveCodec(m, text[body_start..]);

    if (o.media_count == 0) return error.NoMedia;
    var any = false;
    for (o.sections()) |*m| any = any or m.accepted();
    if (!any) return error.NoMedia;
    o.ufrag = ufrag orelse return error.NoIceCredentials;
    o.pwd = pwd orelse return error.NoIceCredentials;
    if (o.ufrag.len == 0 or o.pwd.len == 0) return error.NoIceCredentials;
    o.fingerprint = fingerprint orelse return error.NoFingerprint;
    // Узел всегда сервер DTLS: браузер должен уметь быть клиентом.
    o.setup = setup orelse .actpass;
    if (o.setup == .passive) return error.DtlsRoleUnsupported;
    for (o.media[0..o.media_count]) |*m| {
        if (m.max_message_size == 0) m.max_message_size = 1 << 30; // 0 — без предела
    }
    return o;
}

/// «1 urn:…» или «1/sendonly urn:… атрибуты»: номер и название расширения.
fn addExt(m: *Media, v: []const u8) void {
    var f = std.mem.tokenizeScalar(u8, v, ' ');
    const id_text = f.next() orelse return;
    const uri = f.next() orelse return;
    const slash = std.mem.findScalar(u8, id_text, '/') orelse id_text.len;
    const id = std.fmt.parseInt(u8, id_text[0..slash], 10) catch return;
    if (id == 0) return;
    const ext = Ext.fromUri(uri) orelse return;
    for (m.extensions()) |x| if (x.ext == ext or x.id == id) return;
    if (m.ext_count == max_ext) return;
    m.ext[m.ext_count] = .{ .id = id, .ext = ext };
    m.ext_count += 1;
}

/// Находит в строках секции кодек, который узел пересылает, его параметры, обратную связь
/// и тип нагрузки повторов. Строки rtpmap, fmtp и rtcp-fb могут идти в любом порядке.
fn resolveCodec(m: *Media, body: []const u8) void {
    if (!m.isRtp()) return;
    var it = lineIterator(body);
    while (it.next()) |raw| {
        const v = attr(std.mem.trimEnd(u8, raw, "\r"), "rtpmap") orelse continue;
        const pt, const name = ptAndRest(v) orelse continue;
        const want = switch (m.kind) {
            .audio => std.ascii.eqlIgnoreCase(name, "opus/48000/2"),
            .video => std.ascii.eqlIgnoreCase(name, "VP8/90000"),
            else => false,
        };
        if (want) {
            m.pt = pt;
            break;
        }
    }
    const main = m.pt orelse return;
    it = lineIterator(body);
    while (it.next()) |raw| {
        const line = std.mem.trimEnd(u8, raw, "\r");
        if (attr(line, "fmtp")) |v| {
            const pt, const params = ptAndRest(v) orelse continue;
            if (pt == main) {
                m.fmtp = params;
            } else if (aptOf(params) == main and isRtx(body, pt)) {
                m.rtx_pt = m.rtx_pt orelse pt;
            }
        }
        if (attr(line, "rtcp-fb")) |v| {
            const sp = std.mem.findScalar(u8, v, ' ') orelse continue;
            const who = v[0..sp];
            const what = std.mem.trim(u8, v[sp + 1 ..], " \t");
            if (!std.mem.eql(u8, who, "*") and (std.fmt.parseInt(u7, who, 10) catch continue) != main) continue;
            if (std.mem.eql(u8, what, "transport-cc")) m.feedback.transport_cc = true;
            if (std.mem.eql(u8, what, "goog-remb")) m.feedback.remb = true;
            if (std.mem.eql(u8, what, "ccm fir")) m.feedback.fir = true;
            if (std.mem.eql(u8, what, "nack")) m.feedback.nack = true;
            if (std.mem.eql(u8, what, "nack pli")) m.feedback.pli = true;
        }
    }
    if (m.kind != .video) m.rtx_pt = null;
}

/// «apt=96» или «apt=96;…» → 96.
fn aptOf(params: []const u8) ?u7 {
    var it = std.mem.tokenizeScalar(u8, params, ';');
    while (it.next()) |p| {
        const kv = std.mem.trim(u8, p, " \t");
        if (std.mem.startsWith(u8, kv, "apt=")) return std.fmt.parseInt(u7, kv[4..], 10) catch null;
    }
    return null;
}

fn isRtx(body: []const u8, pt: u7) bool {
    var it = lineIterator(body);
    while (it.next()) |raw| {
        const v = attr(std.mem.trimEnd(u8, raw, "\r"), "rtpmap") orelse continue;
        const p, const name = ptAndRest(v) orelse continue;
        if (p == pt) return std.ascii.startsWithIgnoreCase(name, "rtx/");
    }
    return false;
}

/// «sha-256 AB:CD:…» → 32 байта; другие хеши не принимаются.
pub fn parseFingerprint(v: []const u8) ?[32]u8 {
    const sp = std.mem.findScalar(u8, v, ' ') orelse return null;
    if (!std.ascii.eqlIgnoreCase(v[0..sp], "sha-256")) return null;
    const hex = std.mem.trim(u8, v[sp + 1 ..], " ");
    if (hex.len != 32 * 3 - 1) return null;
    var out: [32]u8 = undefined;
    for (0..32) |i| {
        if (i > 0 and hex[i * 3 - 1] != ':') return null;
        out[i] = std.fmt.parseInt(u8, hex[i * 3 ..][0..2], 16) catch return null;
    }
    return out;
}

/// Кандидат UDP первого компонента с адресом цифрами: «candidate:…» или то, что после «a=».
/// Имена mDNS (….local) и кандидаты TCP пропускаются: узлу с ними нечего делать.
pub fn parseCandidate(text: []const u8) ?net.IpAddress {
    var s = std.mem.trim(u8, text, " \r\n");
    if (std.mem.startsWith(u8, s, "a=")) s = s[2..];
    if (std.mem.startsWith(u8, s, "candidate:")) s = s["candidate:".len..];
    var f = std.mem.tokenizeScalar(u8, s, ' ');
    _ = f.next() orelse return null; // основание
    const component = f.next() orelse return null;
    const transport = f.next() orelse return null;
    _ = f.next() orelse return null; // приоритет
    const ip = f.next() orelse return null;
    const port_s = f.next() orelse return null;
    if (!std.mem.eql(u8, component, "1") or !std.ascii.eqlIgnoreCase(transport, "udp")) return null;
    const port = std.fmt.parseInt(u16, port_s, 10) catch return null;
    if (port == 0) return null;
    return net.IpAddress.parse(ip, port) catch null;
}

/// Адрес без порта, как его пишут в SDP: «192.0.2.1», «2001:db8::1».
pub fn formatIp(buf: *[64]u8, addr: net.IpAddress) []const u8 {
    switch (addr) {
        .ip4 => |a| return std.fmt.bufPrint(buf, "{d}.{d}.{d}.{d}", .{ a.bytes[0], a.bytes[1], a.bytes[2], a.bytes[3] }) catch unreachable,
        .ip6 => |a| {
            var plain = a;
            plain.port = 0;
            plain.interface = .none;
            const s = std.fmt.bufPrint(buf, "{f}", .{net.IpAddress{ .ip6 = plain }}) catch return "::";
            // «[2001:db8::1]:0» → «2001:db8::1»
            const close = std.mem.findScalar(u8, s, ']') orelse return s;
            return s[1..close];
        },
    }
}

// ---------------------------------------------------------------------------
// Ответ узла.

pub const Candidate = struct {
    addr: net.IpAddress,
    kind: enum { host, srflx },
};

pub const Local = struct {
    session_id: u64,
    /// Растёт с каждым новым ответом в том же сеансе.
    version: u32 = 2,
    ufrag: []const u8,
    pwd: []const u8,
    fingerprint: [32]u8,
    candidates: []const Candidate,
    /// Имя источника в RTCP; оно же — основа названий потоков.
    cname: []const u8,
    /// Чем узел шлёт в каждой секции offer, по её номеру: основной поток и поток повторов.
    ssrc: [max_media][2]u32,
    max_message_size: u32,
};

pub fn writeAnswer(buf: []u8, o: *const Offer, l: *const Local) error{NoSpaceLeft}![]const u8 {
    var w: std.Io.Writer = .fixed(buf);
    write(&w, o, l) catch return error.NoSpaceLeft;
    return w.buffered();
}

fn write(w: *std.Io.Writer, o: *const Offer, l: *const Local) std.Io.Writer.Error!void {
    try w.print("v=0\r\no=- {d} {d} IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE", .{ l.session_id, l.version });
    for (o.sections()) |*m| {
        if (m.accepted()) try w.print(" {s}", .{m.mid});
    }
    try w.writeAll("\r\n");
    if (o.allow_mixed) try w.writeAll("a=extmap-allow-mixed\r\n");
    try w.writeAll("a=msid-semantic: WMS *\r\n");

    var first = true; // кандидаты пишутся в первой принятой секции: транспорт один на все
    for (o.sections(), 0..) |*m, index| {
        if (!m.accepted()) {
            // Отказ: порт 0, секция вне группы.
            try w.print("m={s} 0 {s} {s}\r\nc=IN IP4 0.0.0.0\r\n", .{ m.kind_text, m.proto, if (m.first_fmt.len > 0) m.first_fmt else "0" });
            if (m.mid.len > 0) try w.print("a=mid:{s}\r\n", .{m.mid});
            if (m.isRtp()) try w.writeAll("a=inactive\r\n");
            continue;
        }
        if (m.kind == .application) {
            try w.print("m=application 9 {s} webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n", .{m.proto});
        } else {
            try w.print("m={s} 9 {s} {d}", .{ m.kind_text, m.proto, m.pt.? });
            if (m.rtx_pt) |rtx| try w.print(" {d}", .{rtx});
            try w.writeAll("\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\n");
        }
        if (first) {
            first = false;
            try writeCandidates(w, l.candidates);
        }
        try w.print("a=ice-ufrag:{s}\r\na=ice-pwd:{s}\r\na=ice-options:trickle\r\na=fingerprint:sha-256 ", .{ l.ufrag, l.pwd });
        for (l.fingerprint, 0..) |byte, i| try w.print("{s}{X:0>2}", .{ if (i == 0) "" else ":", byte });
        try w.print("\r\na=setup:passive\r\na=mid:{s}\r\n", .{m.mid});
        if (m.kind == .application) {
            try w.print("a=sctp-port:5000\r\na=max-message-size:{d}\r\n", .{l.max_message_size});
            continue;
        }
        for (m.extensions()) |x| try w.print("a=extmap:{d} {s}\r\n", .{ x.id, x.ext.uri() });
        const direction = m.direction.reverse();
        try w.print("a={t}\r\n", .{direction});
        if (direction.sends()) try w.print("a=msid:{s}-{d} {s}-{d}-{s}\r\n", .{ l.cname, streamGroup(o, index), l.cname, index, m.kind_text });
        try w.writeAll("a=rtcp-mux\r\n");
        if (m.rtcp_rsize) try w.writeAll("a=rtcp-rsize\r\n");
        if (m.rtcp_xr.len > 0) try w.print("a=rtcp-xr:{s}\r\n", .{m.rtcp_xr});
        const pt = m.pt.?;
        try w.print("a=rtpmap:{d} {s}\r\n", .{ pt, if (m.kind == .audio) "opus/48000/2" else "VP8/90000" });
        if (m.feedback.remb) try w.print("a=rtcp-fb:{d} goog-remb\r\n", .{pt});
        if (m.feedback.transport_cc) try w.print("a=rtcp-fb:{d} transport-cc\r\n", .{pt});
        if (m.feedback.fir) try w.print("a=rtcp-fb:{d} ccm fir\r\n", .{pt});
        if (m.feedback.nack) try w.print("a=rtcp-fb:{d} nack\r\n", .{pt});
        if (m.feedback.pli) try w.print("a=rtcp-fb:{d} nack pli\r\n", .{pt});
        if (m.fmtp.len > 0) try w.print("a=fmtp:{d} {s}\r\n", .{ pt, m.fmtp });
        if (m.rtx_pt) |rtx| try w.print("a=rtpmap:{d} rtx/90000\r\na=fmtp:{d} apt={d}\r\n", .{ rtx, rtx, pt });
        if (direction.sends()) {
            const ssrc = l.ssrc[index];
            if (m.rtx_pt != null) {
                try w.print("a=ssrc-group:FID {d} {d}\r\na=ssrc:{d} cname:{s}\r\na=ssrc:{d} cname:{s}\r\n", .{ ssrc[0], ssrc[1], ssrc[0], l.cname, ssrc[1], l.cname });
            } else {
                try w.print("a=ssrc:{d} cname:{s}\r\n", .{ ssrc[0], l.cname });
            }
        }
    }
}

/// Группа синхронизации секции: номер первой секции offer с тем же потоком в a=msid.
/// У страницы микрофон и камера в одном потоке — и узел шлёт их одной группой, чтобы
/// браузер сводил звук с картинкой.
fn streamGroup(o: *const Offer, index: usize) usize {
    const stream = o.media[index].stream;
    if (stream.len == 0) return index;
    for (o.sections(), 0..) |*m, i| {
        if (std.mem.eql(u8, m.stream, stream)) return i;
    }
    return index;
}

fn writeCandidates(w: *std.Io.Writer, candidates: []const Candidate) std.Io.Writer.Error!void {
    for (candidates, 0..) |c, i| {
        var ip_buf: [64]u8 = undefined;
        const ip = formatIp(&ip_buf, c.addr);
        const local_pref: u32 = @intCast(65535 - @min(i, 65535));
        switch (c.kind) {
            .host => try w.print("a=candidate:{d} 1 udp {d} {s} {d} typ host\r\n", .{ i + 1, priority(126, local_pref), ip, c.addr.getPort() }),
            .srflx => try w.print("a=candidate:{d} 1 udp {d} {s} {d} typ srflx raddr {s} rport 0\r\n", .{
                i + 1,
                priority(100, local_pref),
                ip,
                c.addr.getPort(),
                if (c.addr == .ip4) "0.0.0.0" else "::",
            }),
        }
    }
    try w.writeAll("a=end-of-candidates\r\n");
}

fn priority(type_pref: u32, local_pref: u32) u32 {
    return (type_pref << 24) | (local_pref << 8) | (256 - 1);
}

// ---------------------------------------------------------------------------

const chrome_offer = @embedFile("testdata/chrome_157_offer.sdp");

test "sdp: offer Chrome с пятью каналами страницы" {
    const o = try parseOffer(chrome_offer);
    try std.testing.expectEqualStrings("6043501147697230252", o.session_id);
    try std.testing.expectEqualStrings("pU4I", o.ufrag);
    try std.testing.expectEqualStrings("2lotAwKeTJ/ENE9FFp/q0Qno", o.pwd);
    try std.testing.expectEqual(@as(u8, 0xAE), o.fingerprint[0]);
    try std.testing.expectEqual(@as(u8, 0xB9), o.fingerprint[31]);
    try std.testing.expectEqual(Setup.actpass, o.setup);
    try std.testing.expect(o.allow_mixed);
    // Два адреса узла сети и внешний; кандидаты TCP пропущены.
    try std.testing.expectEqual(@as(usize, 3), o.candidate_count);
    try std.testing.expectEqualSlices(u8, &.{ 203, 0, 113, 50 }, &o.candidates[2].ip4.bytes);

    try std.testing.expectEqual(@as(usize, 5), o.media_count);
    const kinds = [_]Kind{ .audio, .video, .video, .audio, .application };
    for (o.sections(), kinds, 0..) |*m, kind, i| {
        try std.testing.expectEqual(kind, m.kind);
        try std.testing.expect(m.accepted());
        try std.testing.expectEqual(@as(u8, '0') + @as(u8, @intCast(i)), m.mid[0]);
    }
    const mic = &o.media[0];
    try std.testing.expectEqual(@as(?u7, 111), mic.pt);
    try std.testing.expectEqual(@as(?u7, null), mic.rtx_pt);
    try std.testing.expectEqualStrings("minptime=10;useinbandfec=1", mic.fmtp);
    try std.testing.expectEqual(Feedback{ .transport_cc = true }, mic.feedback);
    try std.testing.expectEqual(@as(u32, 3557070677), mic.ssrc);
    try std.testing.expectEqual(@as(u32, 0), mic.rtx_ssrc);
    try std.testing.expect(mic.rtcp_mux and mic.rtcp_rsize);
    try std.testing.expectEqualStrings("rcvr-rtt=all", mic.rtcp_xr);
    try std.testing.expectEqual(Direction.sendrecv, mic.direction);
    try std.testing.expectEqual(@as(usize, 4), mic.ext_count);
    try std.testing.expectEqual(@as(u8, 1), mic.extId(.audio_level));
    try std.testing.expectEqual(@as(u8, 4), mic.extId(.mid));
    try std.testing.expectEqual(@as(u8, 0), mic.extId(.video_orientation));

    const cam = &o.media[1];
    try std.testing.expectEqual(@as(?u7, 96), cam.pt);
    try std.testing.expectEqual(@as(?u7, 97), cam.rtx_pt);
    try std.testing.expectEqualStrings("", cam.fmtp);
    try std.testing.expectEqual(Feedback{ .transport_cc = true, .remb = true, .fir = true, .nack = true, .pli = true }, cam.feedback);
    try std.testing.expectEqual(@as(u32, 1666214973), cam.ssrc);
    try std.testing.expectEqual(@as(u32, 1458837552), cam.rtx_ssrc);
    // toffset и номера слоёв (rid) узел не пропускает.
    try std.testing.expectEqual(@as(usize, 8), cam.ext_count);
    try std.testing.expectEqual(@as(u8, 13), cam.extId(.video_orientation));
    try std.testing.expectEqual(@as(u8, 3), cam.extId(.transport_cc));
    // Микрофон с камерой и экран со своим звуком — два потока.
    try std.testing.expectEqualStrings(mic.stream, cam.stream);
    try std.testing.expectEqualStrings(o.media[2].stream, o.media[3].stream);
    try std.testing.expect(!std.mem.eql(u8, cam.stream, o.media[2].stream));
    try std.testing.expectEqual(@as(u32, 2019411325), o.media[2].ssrc);
    try std.testing.expectEqual(@as(u32, 837689762), o.media[3].ssrc);

    const data = &o.media[4];
    try std.testing.expect(data.datachannel);
    try std.testing.expectEqual(@as(u32, 262144), data.max_message_size);
    try std.testing.expectEqual(@as(u16, 5000), data.sctp_port);
}

fn testLocal(candidates: []const Candidate) Local {
    var l: Local = .{
        .session_id = 42,
        .ufrag = "abcd",
        .pwd = "0123456789abcdefghijklmn",
        .fingerprint = undefined,
        .candidates = candidates,
        .cname = "zv7",
        .ssrc = undefined,
        .max_message_size = 65536,
    };
    for (&l.fingerprint, 0..) |*b, i| b.* = @intCast(i);
    for (&l.ssrc, 0..) |*s, i| s.* = .{ @intCast(1000 + i * 2), @intCast(1001 + i * 2) };
    return l;
}

test "sdp: answer узла на offer Chrome" {
    const o = try parseOffer(chrome_offer);
    const cands = [_]Candidate{
        .{ .addr = .{ .ip4 = .{ .bytes = .{ 192, 168, 1, 10 }, .port = 40000 } }, .kind = .host },
        .{ .addr = .{ .ip4 = .{ .bytes = .{ 203, 0, 113, 9 }, .port = 41000 } }, .kind = .srflx },
        .{ .addr = try net.IpAddress.parse("2001:db8::7", 40000), .kind = .srflx },
    };
    const l = testLocal(&cands);
    var buf: [8192]u8 = undefined;
    const s = try writeAnswer(&buf, &o, &l);
    const has = struct {
        fn f(text: []const u8, needle: []const u8) !void {
            if (std.mem.find(u8, text, needle) == null) {
                std.debug.print("в ответе нет строки: {s}\n", .{needle});
                return error.TestExpectedLine;
            }
        }
    }.f;
    try has(s, "a=group:BUNDLE 0 1 2 3 4\r\n");
    try has(s, "a=extmap-allow-mixed\r\n");
    try has(s, "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n");
    try has(s, "m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\n");
    try has(s, "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n");
    try has(s, "a=setup:passive\r\n");
    try has(s, "a=fingerprint:sha-256 00:01:02:03:");
    try has(s, " 192.168.1.10 40000 typ host\r\n");
    try has(s, " 203.0.113.9 41000 typ srflx raddr 0.0.0.0 rport 0\r\n");
    try has(s, " 2001:db8::7 40000 typ srflx raddr :: rport 0\r\n");
    try has(s, "a=rtpmap:111 opus/48000/2\r\na=rtcp-fb:111 transport-cc\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=ssrc:1000 cname:zv7\r\n");
    try has(s, "a=rtpmap:96 VP8/90000\r\na=rtcp-fb:96 goog-remb\r\na=rtcp-fb:96 transport-cc\r\na=rtcp-fb:96 ccm fir\r\na=rtcp-fb:96 nack\r\na=rtcp-fb:96 nack pli\r\n" ++
        "a=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=ssrc-group:FID 1002 1003\r\na=ssrc:1002 cname:zv7\r\na=ssrc:1003 cname:zv7\r\n");
    try has(s, "a=ssrc-group:FID 1004 1005\r\n");
    try has(s, "a=ssrc:1006 cname:zv7\r\n");
    // Микрофон и камера — одна группа синхронизации, экран и его звук — другая.
    try has(s, "a=msid:zv7-0 zv7-0-audio\r\n");
    try has(s, "a=msid:zv7-0 zv7-1-video\r\n");
    try has(s, "a=msid:zv7-2 zv7-2-video\r\n");
    try has(s, "a=msid:zv7-2 zv7-3-audio\r\n");
    try has(s, "a=extmap:13 urn:3gpp:video-orientation\r\n");
    try has(s, "a=sctp-port:5000\r\na=max-message-size:65536\r\n");
    try has(s, "a=rtcp-xr:rcvr-rtt=all\r\n");
    // Чужих кодеков и расширений в ответе нет; кандидаты записаны один раз.
    for ([_][]const u8{ "H264", "VP9", "AV1", "red/", "toffset", "rtp-stream-id", "telephone-event" }) |no| {
        try std.testing.expectEqual(@as(?usize, null), std.mem.find(u8, s, no));
    }
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, s, "a=end-of-candidates"));
    try std.testing.expectEqual(@as(usize, 4), std.mem.count(u8, s, "a=sendrecv\r\n"));

    // Свой ответ узел читает как описание: те же секции, кодеки и потоки.
    try std.testing.expectError(error.DtlsRoleUnsupported, parseOffer(s));
    var as_offer: [8192]u8 = undefined;
    const flipped = try std.fmt.bufPrint(&as_offer, "{s}", .{s});
    while (std.mem.find(u8, flipped, "a=setup:passive")) |at| @memcpy(flipped[at..][0..15], "a=setup:actpass");
    const back = try parseOffer(flipped);
    try std.testing.expectEqual(@as(usize, 5), back.media_count);
    try std.testing.expectEqual(@as(?u7, 97), back.media[2].rtx_pt);
    try std.testing.expectEqual(@as(u32, 1004), back.media[2].ssrc);
    try std.testing.expectEqual(@as(u32, 1005), back.media[2].rtx_ssrc);
    try std.testing.expectEqual(@as(usize, 3), back.candidate_count);
    try std.testing.expectEqualStrings("abcd", back.ufrag);
}

test "sdp: секции, которые узел не берёт, получают отказ" {
    // Видео без VP8, секция неизвестного вида, звук только на приём, канал данных.
    const text = "v=0\r\no=- 77 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE a v x d\r\n" ++
        "a=ice-ufrag:uf\r\na=ice-pwd:pw\r\n" ++
        "a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\n" ++
        "m=audio 9 UDP/TLS/RTP/SAVPF 109 0\r\na=mid:a\r\na=recvonly\r\na=rtcp-mux\r\na=rtpmap:109 opus/48000/2\r\na=rtpmap:0 PCMU/8000\r\n" ++
        "m=video 9 UDP/TLS/RTP/SAVPF 102\r\na=mid:v\r\na=sendrecv\r\na=rtcp-mux\r\na=rtpmap:102 H264/90000\r\n" ++
        "m=text 9 UDP/TLS/RTP/SAVPF 98\r\na=mid:x\r\n" ++
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:d\r\na=sctp-port:5000\r\na=max-message-size:0\r\n";
    const o = try parseOffer(text);
    try std.testing.expectEqual(@as(usize, 4), o.media_count);
    try std.testing.expect(o.media[0].accepted());
    try std.testing.expect(!o.media[1].accepted());
    try std.testing.expect(!o.media[2].accepted());
    try std.testing.expect(o.media[3].accepted());
    try std.testing.expectEqual(@as(u32, 1 << 30), o.media[3].max_message_size);
    try std.testing.expectEqualStrings("77", o.session_id);
    const l = testLocal(&.{});
    var buf: [4096]u8 = undefined;
    const s = try writeAnswer(&buf, &o, &l);
    try std.testing.expect(std.mem.find(u8, s, "a=group:BUNDLE a d\r\n") != null);
    try std.testing.expect(std.mem.find(u8, s, "m=video 0 UDP/TLS/RTP/SAVPF 102\r\n") != null);
    try std.testing.expect(std.mem.find(u8, s, "m=text 0 UDP/TLS/RTP/SAVPF 98\r\n") != null);
    // Браузер только принимает — узел только шлёт.
    try std.testing.expect(std.mem.find(u8, s, "m=audio 9 UDP/TLS/RTP/SAVPF 109\r\n") != null);
    try std.testing.expect(std.mem.find(u8, s, "a=sendonly\r\n") != null);
    try std.testing.expect(std.mem.find(u8, s, "a=ssrc:1000 cname:zv7\r\n") != null);
    try std.testing.expectError(error.NoSpaceLeft, writeAnswer(buf[0..200], &o, &l));
}

test "sdp: негодные описания" {
    const fp = "a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\n";
    const dc = "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n";
    try std.testing.expectError(error.NoMedia, parseOffer("v=0\r\n"));
    try std.testing.expectError(error.NoMedia, parseOffer("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\na=mid:0\r\na=rtcp-mux\r\na=rtpmap:102 H264/90000\r\n"));
    try std.testing.expectError(error.NoIceCredentials, parseOffer("v=0\r\n" ++ dc));
    try std.testing.expectError(error.NoFingerprint, parseOffer("v=0\r\n" ++ dc ++ "a=ice-ufrag:a\r\na=ice-pwd:b\r\n"));
    try std.testing.expectError(error.DtlsRoleUnsupported, parseOffer(dc ++ "a=ice-ufrag:a\r\na=ice-pwd:b\r\n" ++ fp ++ "a=setup:passive\r\n"));
    try std.testing.expectError(error.TooManySections, parseOffer((dc ++ dc ++ dc ++ dc ++ dc ++ dc ++ dc ++ dc ++ dc)));
    try std.testing.expectEqual(@as(?[32]u8, null), parseFingerprint("sha-1 00:11"));
    // Без rtcp-mux медиа-секцию узел не берёт: RTCP у него на том же порту.
    const no_mux = try parseOffer("m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\n" ++ dc ++ "a=ice-ufrag:a\r\na=ice-pwd:b\r\n" ++ fp);
    try std.testing.expect(!no_mux.media[0].accepted());
    // Строки в другом порядке и с окончаниями LF: fmtp раньше rtpmap, rtcp-fb на все типы.
    const odd = try parseOffer("a=ice-ufrag:a\na=ice-pwd:b\n" ++ "a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\n" ++
        "m=video 9 UDP/TLS/RTP/SAVPF 120 121 100\na=mid:v\na=rtcp-mux\na=fmtp:121 apt=120\na=fmtp:100 apt=120\na=rtcp-fb:* nack\n" ++
        "a=rtpmap:100 red/90000\na=rtpmap:121 rtx/90000\na=rtpmap:120 vp8/90000\na=extmap:5/sendrecv urn:ietf:params:rtp-hdrext:sdes:mid\na=ssrc:7 cname:x\na=ssrc:8 cname:x\na=ssrc-group:FID 7 8\n");
    try std.testing.expectEqual(@as(?u7, 120), odd.media[0].pt);
    try std.testing.expectEqual(@as(?u7, 121), odd.media[0].rtx_pt);
    try std.testing.expect(odd.media[0].feedback.nack);
    try std.testing.expectEqual(@as(u8, 5), odd.media[0].extId(.mid));
    try std.testing.expectEqual(@as(u32, 7), odd.media[0].ssrc);
    try std.testing.expectEqual(@as(u32, 8), odd.media[0].rtx_ssrc);
}

// Описание сеанса присылает любой, у кого есть код комнаты: разбор обязан пережить что угодно.
test "sdp: испорченные описания разбор не роняют" {
    var prng: std.Random.DefaultPrng = .init(0x5a564f4e);
    const rnd = prng.random();
    var text: [chrome_offer.len + 64]u8 = undefined;
    var out: [16 * 1024]u8 = undefined;
    var parsed: usize = 0;
    for (0..3000) |round| {
        @memcpy(text[0..chrome_offer.len], chrome_offer);
        var len: usize = chrome_offer.len;
        // Несколько порч сразу: байт заменён, кусок вырезан, кусок повторён, текст обрезан.
        for (0..1 + round % 4) |_| {
            switch (rnd.uintLessThan(u8, 4)) {
                0 => text[rnd.uintLessThan(usize, len)] = rnd.int(u8),
                1 => {
                    const at = rnd.uintLessThan(usize, len);
                    const cut = @min(rnd.uintLessThan(usize, 200), len - at);
                    std.mem.copyForwards(u8, text[at .. len - cut], text[at + cut .. len]);
                    len -= cut;
                },
                2 => {
                    const at = rnd.uintLessThan(usize, len);
                    const n = @min(rnd.uintLessThan(usize, 60), @min(len - at, text.len - len));
                    std.mem.copyBackwards(u8, text[at + n .. len + n], text[at..len]);
                    len += n;
                },
                else => len = 1 + rnd.uintLessThan(usize, len),
            }
            if (len == 0) len = 1;
        }
        const o = parseOffer(text[0..len]) catch continue;
        parsed += 1;
        var l = testLocal(&.{});
        l.cname = "zv";
        _ = writeAnswer(&out, &o, &l) catch {};
    }
    // Большинство порч описание переживает: проверка не свелась к одним отказам.
    try std.testing.expect(parsed > 1000);
}

test "sdp: кандидаты, присланные позже" {
    const c = parseCandidate("candidate:842163049 1 udp 1677729535 198.51.100.4 60000 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag Yqcd network-cost 999").?;
    try std.testing.expectEqualSlices(u8, &.{ 198, 51, 100, 4 }, &c.ip4.bytes);
    try std.testing.expectEqual(@as(?net.IpAddress, null), parseCandidate("candidate:1 2 udp 1 198.51.100.4 60000 typ host"));
    try std.testing.expectEqual(@as(?net.IpAddress, null), parseCandidate("candidate:2489145183 1 udp 2122194687 9d5e5a5c-36f1-4c9a-9a1f-0a2b3c4d5e6f.local 61234 typ host"));
    try std.testing.expectEqual(@as(?net.IpAddress, null), parseCandidate("candidate:1 1 tcp 1518280447 192.168.0.170 9 typ host tcptype active"));
    try std.testing.expectEqual(@as(?net.IpAddress, null), parseCandidate(""));
}
