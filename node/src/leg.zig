//! Плечо — соединение WebRTC узла с браузером одного участника ради другого участника.
//! Браузер А, чтобы связаться с Б через узел, строит с узлом обычное соединение страницы
//! (пять каналов); такое же строит Б ради А. Узел сводит два плеча в пару и пересылает между
//! ними медиа и сообщения канала данных (node.zig).
//!
//! Здесь всё, что у плеча своё: ICE (RFC 8445: узел — управляемая сторона, но и сам шлёт
//! проверки, чтобы его NAT открылся в сторону браузера), DTLS 1.2 (dtls.zig), ключи SRTP
//! (srtp.zig), SCTP с каналом данных (sctp.zig) и разобранное описание сеанса (sdp.zig).
//! Сокет у узла один на все плечи, поток тоже: плечо получает уже разобранные по адресу
//! датаграммы и шлёт свои через `Host`.
const std = @import("std");
const Io = std.Io;
const net = std.Io.net;
const stun = @import("stun.zig");
const sdp = @import("sdp.zig");
const dtls = @import("dtls.zig");
const sctp = @import("sctp.zig");
const srtp = @import("srtp.zig");

/// Идентификатор участника в комнате: 16 шестнадцатеричных знаков.
pub const Id = [16]u8;

const connect_timeout_us: u64 = 30_000_000;
const idle_timeout_us: u64 = 30_000_000;
/// Сколько соединённое плечо шлёт свои проверки ICE после перезапуска или нового кандидата.
const recheck_us: u64 = 15_000_000;
pub const max_tracks = sdp.max_media;
const answer_max = 8 * 1024;
/// Сообщение канала данных, которое узел возьмёт у браузера.
pub const max_message_size = 64 * 1024;

/// Профили SRTP по убыванию предпочтения узла.
pub const srtp_gcm_first = [_]u16{ @backingInt(srtp.Profile.aead_aes128_gcm), @backingInt(srtp.Profile.aes128_cm_sha1_80) };
pub const srtp_cm_only = [_]u16{@backingInt(srtp.Profile.aes128_cm_sha1_80)};
pub const srtp_gcm_only = [_]u16{@backingInt(srtp.Profile.aead_aes128_gcm)};

/// Чем плечо пользуется у узла.
pub const Host = struct {
    ctx: *anyopaque,
    /// Датаграмма на адрес браузера.
    send: *const fn (ctx: *anyopaque, to: net.IpAddress, data: []const u8) void,
    /// Сообщение из канала данных браузера.
    message: *const fn (ctx: *anyopaque, l: *Leg, ppid: u32, data: []const u8) void,
};

/// Медиа-канал плеча: одна секция описания.
pub const Track = struct {
    kind: sdp.Kind,
    mid_buf: [sdp.max_mid]u8 = undefined,
    mid_len: usize = 0,
    /// Типы нагрузки кодека и его повторов на этом плече.
    pt: u7,
    rtx_pt: ?u7,
    /// Чем шлёт браузер: основной поток и повторы; 0 — ещё не знаем.
    remote_ssrc: u32,
    remote_rtx: u32,
    /// Чем шлёт браузеру узел.
    local_ssrc: u32,
    local_rtx: u32,
    ext: [sdp.max_ext]sdp.ExtEntry = undefined,
    ext_count: usize = 0,
    /// Браузер шлёт в этот канал; узел шлёт в него.
    receives: bool,
    sends: bool,
    /// Каким запросом ключевого кадра договорились пользоваться: PLI, FIR.
    pli: bool = false,
    fir: bool = false,
    /// Номер последнего запроса FIR от узла.
    fir_seq: u8 = 0,

    pub fn mid(t: *const Track) []const u8 {
        return t.mid_buf[0..t.mid_len];
    }

    pub fn extId(t: *const Track, e: sdp.Ext) u8 {
        for (t.ext[0..t.ext_count]) |x| if (x.ext == e) return x.id;
        return 0;
    }
};

pub const Stats = struct {
    rtp_in: u64 = 0,
    rtp_out: u64 = 0,
    rtcp_in: u64 = 0,
    rtcp_out: u64 = 0,
    /// Пакеты, которые не прошли проверку SRTP: подделка, повтор, мусор.
    rejected: u64 = 0,
    /// Пакеты RTP, для которых не нашлось канала.
    unknown: u64 = 0,
    messages_in: u64 = 0,
    messages_out: u64 = 0,
};

const Check = struct { tid: [12]u8, to: net.IpAddress };

/// Сообщения канала данных, которые ждут, пока поднимется парное плечо.
const Outbox = struct {
    buf: [16 * 1024]u8 = undefined,
    used: usize = 0,
    items: [32]Item = undefined,
    count: usize = 0,

    const Item = struct { off: u32, len: u32, ppid: u32 };

    /// Кладёт сообщение; если места нет, выбрасывает самые старые. Слишком большое не берёт.
    fn push(o: *Outbox, ppid: u32, data: []const u8) void {
        if (data.len > o.buf.len) return;
        while (o.count == o.items.len or o.used + data.len > o.buf.len) o.dropFirst();
        @memcpy(o.buf[o.used..][0..data.len], data);
        o.items[o.count] = .{ .off = @intCast(o.used), .len = @intCast(data.len), .ppid = ppid };
        o.count += 1;
        o.used += data.len;
    }

    fn dropFirst(o: *Outbox) void {
        const first = o.items[0];
        std.mem.copyForwards(u8, o.buf[0 .. o.used - first.len], o.buf[first.len..o.used]);
        o.used -= first.len;
        o.count -= 1;
        for (0..o.count) |i| {
            o.items[i] = o.items[i + 1];
            o.items[i].off -= first.len;
        }
    }

    fn clear(o: *Outbox) void {
        o.used = 0;
        o.count = 0;
    }
};

pub const Leg = struct {
    io: Io,
    host: Host,
    /// Чей это браузер и ради какого участника соединение.
    owner: Id,
    peer: Id,
    /// Парное плечо: браузер участника `peer`, соединённый ради `owner`.
    partner: ?*Leg = null,

    /// Номер сеанса из описания браузера: по нему отличаем пересогласование от нового соединения.
    session_buf: [40]u8 = undefined,
    session_len: usize = 0,
    answer_buf: [answer_max]u8 = undefined,
    answer_len: usize = 0,
    answer_version: u32 = 2,
    answer_id: u64,
    cname: [10]u8,
    tracks: [max_tracks]Track = undefined,
    track_count: usize = 0,
    /// Сколько байт в одном сообщении канала данных принимает браузер.
    peer_max_message: u32 = 65536,

    // ICE.
    local_ufrag: [8]u8 = undefined,
    local_pwd: [24]u8 = undefined,
    remote_ufrag_buf: [256]u8 = undefined,
    remote_ufrag_len: usize = 0,
    remote_pwd_buf: [256]u8 = undefined,
    remote_pwd_len: usize = 0,
    tie_breaker: u64,
    /// Сокет узла двухстековый: иначе адреса IPv6 плечу ни к чему.
    dual: bool,
    remote: [sdp.max_candidates]net.IpAddress = undefined,
    remote_count: usize = 0,
    /// Адреса, доказавшие, что знают пароль ICE: только с них принимаются DTLS и медиа.
    valid: [8]net.IpAddress = undefined,
    valid_count: usize = 0,
    selected: ?net.IpAddress = null,
    /// Последние отправленные проверки: по ним узнаются ответы; заполнены первые `check_count`.
    checks: [32]Check = undefined,
    check_next: usize = 0,
    check_count: usize = 0,
    next_check_us: u64 = 0,
    /// Когда ICE начат (или перезапущен) и до какого времени плечо шлёт свои проверки и после
    /// рукопожатия: новый путь у уже соединённого плеча тоже надо открыть со своей стороны.
    ice_started_us: u64 = 0,
    check_until_us: u64 = 0,

    tls: dtls.Server,
    srtp_in: srtp.Context = undefined,
    srtp_out: srtp.Context = undefined,
    /// Ключи SRTP выведены: медиа можно принимать и слать.
    media_ready: bool = false,
    profile: ?srtp.Profile = null,
    assoc: sctp.Association,
    /// Рукопожатие закончилось, и узел это уже заметил; то же — про канал данных.
    noticed: bool = false,
    data_ready: bool = false,
    outbox: Outbox = .{},

    now_us: u64,
    started_us: u64,
    last_rx_us: u64,
    /// Плечо закрыто: узел уберёт его при следующем обходе.
    dead: bool = false,
    reason: []const u8 = "",
    stats: Stats = .{},

    pub const CreateError = error{ OutOfMemory, BadOffer };

    /// Заводит плечо по offer браузера. Ответ строится отдельно — `describe`.
    pub fn create(gpa: std.mem.Allocator, io: Io, host: Host, identity: *const dtls.Identity, srtp_profiles: []const u16, owner: Id, peer: Id, o: *const sdp.Offer, dual: bool, now_us: u64) CreateError!*Leg {
        if (o.ufrag.len > 255 or o.pwd.len > 255 or o.session_id.len > 40) return error.BadOffer;
        const l = try gpa.create(Leg);
        var rnd: [24]u8 = undefined;
        io.random(&rnd);
        l.* = .{
            .io = io,
            .host = host,
            .owner = owner,
            .peer = peer,
            .answer_id = std.mem.readInt(u64, rnd[0..8], .little) >> 2,
            .cname = undefined,
            .tie_breaker = std.mem.readInt(u64, rnd[8..16], .little),
            .dual = dual,
            .tls = undefined,
            .assoc = undefined,
            .now_us = now_us,
            .started_us = now_us,
            .last_rx_us = now_us,
        };
        _ = std.fmt.bufPrint(&l.cname, "zv{x}", .{rnd[16..20]}) catch unreachable;
        l.tls.init(io, identity, o.fingerprint, srtp_profiles);
        l.assoc.init(io);
        @memcpy(l.session_buf[0..o.session_id.len], o.session_id);
        l.session_len = o.session_id.len;
        l.setTracks(o);
        l.setIce(o);
        l.ice_started_us = now_us;
        return l;
    }

    pub fn destroy(l: *Leg, gpa: std.mem.Allocator) void {
        std.crypto.secureZero(u8, std.mem.asBytes(&l.srtp_in));
        std.crypto.secureZero(u8, std.mem.asBytes(&l.srtp_out));
        std.crypto.secureZero(u8, &l.tls.master);
        gpa.destroy(l);
    }

    pub fn sessionId(l: *const Leg) []const u8 {
        return l.session_buf[0..l.session_len];
    }

    pub fn remoteUfrag(l: *const Leg) []const u8 {
        return l.remote_ufrag_buf[0..l.remote_ufrag_len];
    }

    fn remotePwd(l: *const Leg) []const u8 {
        return l.remote_pwd_buf[0..l.remote_pwd_len];
    }

    pub fn answer(l: *const Leg) []const u8 {
        return l.answer_buf[0..l.answer_len];
    }

    pub fn established(l: *const Leg) bool {
        return l.tls.established();
    }

    // ------------------------------------------------------------------ описание сеанса

    /// Каналы плеча по медиа-секциям описания. SSRC узла у секции остаются прежними, если
    /// описание пришло повторно.
    fn setTracks(l: *Leg, o: *const sdp.Offer) void {
        var old: [max_tracks]Track = undefined;
        const old_count = l.track_count;
        @memcpy(old[0..old_count], l.tracks[0..old_count]);
        l.track_count = 0;
        for (o.sections()) |*m| {
            if (m.kind == .application and m.accepted()) l.peer_max_message = m.max_message_size;
            if (!m.isRtp() or !m.accepted()) continue;
            if (l.track_count == max_tracks) break;
            const n = l.track_count;
            var t: Track = .{
                .kind = m.kind,
                .pt = m.pt.?,
                .rtx_pt = m.rtx_pt,
                .remote_ssrc = m.ssrc,
                .remote_rtx = m.rtx_ssrc,
                .local_ssrc = 0,
                .local_rtx = 0,
                .receives = m.direction.sends(),
                .sends = m.direction.reverse().sends(),
                .pli = m.feedback.pli,
                .fir = m.feedback.fir,
            };
            @memcpy(t.mid_buf[0..m.mid.len], m.mid);
            t.mid_len = m.mid.len;
            @memcpy(t.ext[0..m.ext_count], m.extensions());
            t.ext_count = m.ext_count;
            if (n < old_count and old[n].kind == t.kind) {
                t.local_ssrc = old[n].local_ssrc;
                t.local_rtx = old[n].local_rtx;
                t.fir_seq = old[n].fir_seq;
                // Поток, который узнали по пакетам, а в описании его нет, не забываем.
                if (t.remote_ssrc == 0) t.remote_ssrc = old[n].remote_ssrc;
                if (t.remote_rtx == 0) t.remote_rtx = old[n].remote_rtx;
            }
            l.tracks[n] = t;
            l.track_count += 1;
        }
        for (l.tracks[0..l.track_count]) |*t| {
            if (t.local_ssrc == 0) t.local_ssrc = l.newSsrc(o);
            if (t.local_rtx == 0) t.local_rtx = l.newSsrc(o);
        }
    }

    /// Случайный SSRC, не занятый ни браузером, ни другим каналом плеча.
    fn newSsrc(l: *Leg, o: *const sdp.Offer) u32 {
        while (true) {
            var b: [4]u8 = undefined;
            l.io.random(&b);
            const v = std.mem.readInt(u32, &b, .little);
            if (v < 0x100) continue; // малые числа браузеры берут себе (Chrome шлёт отчёты от SSRC 1)
            var taken = false;
            for (o.sections()) |*m| taken = taken or m.ssrc == v or m.rtx_ssrc == v;
            for (l.tracks[0..l.track_count]) |*t| taken = taken or t.local_ssrc == v or t.local_rtx == v;
            if (!taken) return v;
        }
    }

    /// Данные ICE из описания: логин и пароль браузера, его кандидаты; свои логин и пароль — новые.
    fn setIce(l: *Leg, o: *const sdp.Offer) void {
        randomIceChars(l.io, &l.local_ufrag);
        randomIceChars(l.io, &l.local_pwd);
        @memcpy(l.remote_ufrag_buf[0..o.ufrag.len], o.ufrag);
        l.remote_ufrag_len = o.ufrag.len;
        @memcpy(l.remote_pwd_buf[0..o.pwd.len], o.pwd);
        l.remote_pwd_len = o.pwd.len;
        l.remote_count = 0;
        l.check_count = 0;
        l.check_next = 0;
        for (o.candidates[0..o.candidate_count]) |c| _ = l.addRemote(c);
        l.next_check_us = 0;
    }

    /// Браузер перезапускает ICE в том же сеансе: новые логины и пароли, кандидаты и проверки
    /// с начала. DTLS и ключи остаются, выбранный путь служит, пока не появится новый.
    pub fn restartIce(l: *Leg, o: *const sdp.Offer, now_us: u64) CreateError!void {
        if (o.ufrag.len > 255 or o.pwd.len > 255) return error.BadOffer;
        l.setTracks(o);
        l.setIce(o);
        l.answer_version += 1;
        l.last_rx_us = now_us; // отсчёт тишины — с перезапуска
        l.ice_started_us = now_us;
        l.check_until_us = now_us + recheck_us;
    }

    /// Строит ответ узла с его нынешними кандидатами.
    pub fn describe(l: *Leg, o: *const sdp.Offer, candidates: []const sdp.Candidate) error{NoSpaceLeft}!void {
        var local: sdp.Local = .{
            .session_id = l.answer_id,
            .version = l.answer_version,
            .ufrag = &l.local_ufrag,
            .pwd = &l.local_pwd,
            .fingerprint = l.tls.identity.fingerprint,
            .candidates = candidates,
            .cname = &l.cname,
            .ssrc = @splat(.{ 0, 0 }),
            .max_message_size = max_message_size,
        };
        // Каналы плеча идут в порядке принятых медиа-секций описания.
        var n: usize = 0;
        for (o.sections(), 0..) |*m, i| {
            if (!m.isRtp() or !m.accepted()) continue;
            if (n == l.track_count) break;
            local.ssrc[i] = .{ l.tracks[n].local_ssrc, l.tracks[n].local_rtx };
            n += 1;
        }
        l.answer_len = (try sdp.writeAnswer(&l.answer_buf, o, &local)).len;
    }

    // ------------------------------------------------------------------ ICE

    /// Кандидат, который браузер нашёл после offer. true — адрес новый: он проверяется сразу,
    /// даже если плечо уже соединено (у браузера появилась другая сеть).
    pub fn addCandidate(l: *Leg, addr: net.IpAddress, now_us: u64) bool {
        if (!l.addRemote(addr)) return false;
        l.next_check_us = 0;
        if (l.established()) l.check_until_us = @max(l.check_until_us, now_us + recheck_us);
        return true;
    }

    /// Плечо сейчас шлёт свои проверки: до рукопожатия и какое-то время после перезапуска ICE.
    fn checking(l: *const Leg, now_us: u64) bool {
        return !l.established() or now_us < l.check_until_us;
    }

    /// false — адрес не годится, уже известен или места нет.
    fn addRemote(l: *Leg, addr_in: net.IpAddress) bool {
        const addr = normalize(addr_in);
        if (addr == .ip6 and !l.dual) return false;
        if (!routable(addr)) return false;
        for (l.remote[0..l.remote_count]) |*c| if (c.eql(&addr)) return false;
        if (l.remote_count == l.remote.len) return false;
        l.remote[l.remote_count] = addr;
        l.remote_count += 1;
        return true;
    }

    fn sendCheck(l: *Leg, to: net.IpAddress) void {
        var tid: [12]u8 = undefined;
        l.io.random(&tid);
        var b: [512]u8 = undefined;
        var m = stun.Builder.init(&b, stun.binding_request, tid);
        var user: [256 + 1 + 8]u8 = undefined;
        const u = std.fmt.bufPrint(&user, "{s}:{s}", .{ l.remoteUfrag(), &l.local_ufrag }) catch return;
        m.add(stun.attr_username, u);
        m.addU64(stun.attr_ice_controlled, l.tie_breaker);
        m.addU32(stun.attr_priority, stun.priority(110, 65535));
        m.addIntegrity(l.remotePwd());
        m.addFingerprint();
        l.checks[l.check_next] = .{ .tid = tid, .to = to };
        l.check_next = (l.check_next + 1) % l.checks.len;
        l.check_count = @min(l.check_count + 1, l.checks.len);
        l.host.send(l.host.ctx, to, m.bytes());
    }

    /// Запрос этому плечу? По логину: «наш:их».
    pub fn ownsRequest(l: *const Leg, m: *const stun.Message) bool {
        const user = m.username orelse return false;
        return user.len > l.local_ufrag.len and std.mem.startsWith(u8, user, &l.local_ufrag) and user[l.local_ufrag.len] == ':';
    }

    /// Проверка связи от браузера. true — запрос подлинный, и адрес теперь годится для плеча.
    pub fn onBindingRequest(l: *Leg, from: net.IpAddress, m: *const stun.Message, now_us: u64) bool {
        l.now_us = now_us;
        if (!l.ownsRequest(m)) return false;
        if (!m.checkIntegrity(&l.local_pwd)) return false;
        if (m.fingerprint_at != null and !m.checkFingerprint()) return false;
        var b: [512]u8 = undefined;
        var r = stun.Builder.init(&b, stun.binding_success, m.tid);
        r.addXorAddress(from);
        r.addIntegrity(&l.local_pwd);
        r.addFingerprint();
        l.host.send(l.host.ctx, from, r.bytes());
        l.last_rx_us = now_us;
        const known = l.isValid(from);
        l.markValid(from);
        if (!known) {
            // Новый путь (браузер виден с адреса, которого не было среди кандидатов): проверяем в ответ.
            _ = l.addRemote(from);
            if (l.checking(now_us)) l.sendCheck(from);
        }
        if (m.use_candidate or l.selected == null) l.selected = from;
        return true;
    }

    /// Ответ на проверку, которую слало это плечо: адрес, куда она ушла, теперь годится.
    pub fn onBindingSuccess(l: *Leg, m: *const stun.Message, now_us: u64) ?net.IpAddress {
        l.now_us = now_us;
        for (l.checks[0..l.check_count]) |c| {
            if (!std.mem.eql(u8, &c.tid, &m.tid)) continue;
            if (!m.checkIntegrity(l.remotePwd())) return null;
            l.markValid(c.to);
            if (l.selected == null) l.selected = c.to;
            return c.to;
        }
        return null;
    }

    pub fn isValid(l: *const Leg, a: net.IpAddress) bool {
        for (l.valid[0..l.valid_count]) |*v| if (v.eql(&a)) return true;
        return false;
    }

    fn markValid(l: *Leg, a: net.IpAddress) void {
        if (l.isValid(a)) return;
        if (l.valid_count == l.valid.len) {
            std.mem.copyForwards(net.IpAddress, l.valid[0 .. l.valid.len - 1], l.valid[1..]);
            l.valid_count -= 1;
        }
        l.valid[l.valid_count] = a;
        l.valid_count += 1;
    }

    /// Адрес браузера для журнала.
    pub fn peerAddress(l: *const Leg, buf: *[64]u8) []const u8 {
        const a = l.selected orelse return "?";
        return sdp.formatIp(buf, a);
    }

    // ------------------------------------------------------------------ DTLS, SRTP, SCTP

    /// Запись DTLS с проверенного адреса.
    pub fn onDtls(l: *Leg, from: net.IpAddress, data: []u8, now_us: u64) void {
        l.now_us = now_us;
        if (l.selected == null or !l.selected.?.eql(&from)) l.selected = from;
        l.last_rx_us = now_us;
        l.tls.handle(data, now_us, l.dtlsSink());
        if (!l.media_ready and l.tls.established()) l.setupSrtp();
    }

    /// Рукопожатие закончено: из его секрета — ключи SRTP обоих направлений.
    fn setupSrtp(l: *Leg) void {
        const id = l.tls.srtp_profile orelse return; // браузер медиа не предлагал: только канал данных
        const profile: srtp.Profile = switch (id) {
            @backingInt(srtp.Profile.aes128_cm_sha1_80) => .aes128_cm_sha1_80,
            @backingInt(srtp.Profile.aead_aes128_gcm) => .aead_aes128_gcm,
            else => return,
        };
        var material: [2 * (16 + 14)]u8 = undefined;
        const m = material[0..profile.materialLen()];
        l.tls.exportSrtp(m);
        const salt = profile.saltLen();
        // Подряд: ключ клиента, ключ сервера, соль клиента, соль сервера. Клиент — браузер.
        l.srtp_in.init(profile, m[0..16].*, m[32..][0..salt]);
        l.srtp_out.init(profile, m[16..32].*, m[32 + salt ..][0..salt]);
        std.crypto.secureZero(u8, &material);
        l.profile = profile;
        l.media_ready = true;
    }

    /// Таймеры плеча: проверки ICE, повторы DTLS и SCTP, тишина.
    pub fn tick(l: *Leg, now_us: u64) void {
        if (l.dead) return;
        l.now_us = now_us;
        if (l.tls.state == .failed) return l.kill(l.tls.reason);
        if (l.tls.state == .closed or l.assoc.state == .closed) return l.kill("браузер закрыл соединение");
        if (!l.established() and now_us -| l.started_us > connect_timeout_us) return l.kill("нет пути до браузера (ICE)");
        if (now_us -| l.last_rx_us > idle_timeout_us) return l.kill("браузер замолчал");
        if (l.checking(now_us) and now_us >= l.next_check_us) {
            // Проверки открывают наш NAT к каждому кандидату браузера: сначала часто, потом реже.
            l.next_check_us = now_us + if (now_us -| l.ice_started_us < 3_000_000) @as(u64, 100_000) else 400_000;
            for (l.remote[0..l.remote_count]) |to| l.sendCheck(to);
        }
        l.tls.tick(now_us, l.dtlsSink());
        l.assoc.tick(now_us, l.sctpSink());
    }

    /// Закрывает плечо: браузеру уходят ABORT и close_notify, узел уберёт плечо сам.
    pub fn kill(l: *Leg, reason: []const u8) void {
        if (l.dead) return;
        l.dead = true;
        l.reason = reason;
        l.assoc.abort(l.sctpSink());
        l.tls.close(l.dtlsSink());
    }

    pub fn send(l: *Leg, datagram: []const u8) void {
        const to = l.selected orelse return;
        l.host.send(l.host.ctx, to, datagram);
    }

    /// Подлинный пакет медиа пришёл с проверенного адреса: браузер шлёт этим путём — им же
    /// отвечает и узел, даже если о смене пути браузер отдельно не объявлял.
    pub fn heardFrom(l: *Leg, from: net.IpAddress, now_us: u64) void {
        l.last_rx_us = now_us;
        if (l.selected == null or !l.selected.?.eql(&from)) l.selected = from;
    }

    pub fn dataOpen(l: *const Leg) bool {
        return !l.dead and l.assoc.state == .established;
    }

    /// Сообщение браузеру по каналу данных. false — канал не готов или переполнен.
    pub fn sendMessage(l: *Leg, ppid: u32, data: []const u8) bool {
        if (!l.dataOpen() or data.len > l.peer_max_message) return false;
        // Канал страницы согласован заранее и живёт в потоке 0.
        l.assoc.queueMessage(0, ppid, data) catch return false;
        l.assoc.flush(l.now_us, l.sctpSink());
        l.stats.messages_out += 1;
        return true;
    }

    /// Сообщения браузера этого плеча, которые ждут парное плечо.
    pub fn hold(l: *Leg, ppid: u32, data: []const u8) void {
        l.outbox.push(ppid, data);
    }

    /// Отдаёт отложенные сообщения парному плечу; что не влезло, остаётся ждать.
    pub fn flushHeld(l: *Leg, to: *Leg) void {
        var sent: usize = 0;
        for (l.outbox.items[0..l.outbox.count]) |it| {
            if (!to.sendMessage(it.ppid, l.outbox.buf[it.off..][0..it.len])) break;
            sent += 1;
        }
        for (0..sent) |_| l.outbox.dropFirst();
    }

    fn dtlsSink(l: *Leg) dtls.Sink {
        return .{ .ctx = l, .send = dtlsSend, .data = dtlsData };
    }

    fn dtlsSend(ctx: *anyopaque, datagram: []const u8) void {
        const l: *Leg = @ptrCast(@alignCast(ctx));
        l.send(datagram);
    }

    fn dtlsData(ctx: *anyopaque, plaintext: []u8) void {
        const l: *Leg = @ptrCast(@alignCast(ctx));
        l.assoc.handlePacket(plaintext, l.now_us, l.sctpSink());
    }

    fn sctpSink(l: *Leg) sctp.Sink {
        return .{ .ctx = l, .send = sctpSend, .message = sctpMessage };
    }

    fn sctpSend(ctx: *anyopaque, packet: []const u8) void {
        const l: *Leg = @ptrCast(@alignCast(ctx));
        l.tls.sendData(packet, l.dtlsSink());
    }

    fn sctpMessage(ctx: *anyopaque, sid: u16, ppid: u32, data: []const u8) void {
        const l: *Leg = @ptrCast(@alignCast(ctx));
        _ = sid;
        if (ppid != sctp.ppid_string and ppid != sctp.ppid_binary) return;
        l.stats.messages_in += 1;
        l.host.message(l.host.ctx, l, ppid, data);
    }

    // ------------------------------------------------------------------ каналы

    pub const Found = struct { track: usize, rtx: bool };

    /// Канал по SSRC пакета; для незнакомого потока — по MID из заголовка или по типу нагрузки,
    /// если он у каналов разный. Узнанный так SSRC запоминается.
    pub fn findTrack(l: *Leg, ssrc: u32, pt: u7, mid_value: ?[]const u8) ?Found {
        const tracks = l.tracks[0..l.track_count];
        for (tracks, 0..) |*t, i| {
            if (!t.receives) continue;
            if (t.remote_ssrc == ssrc) return .{ .track = i, .rtx = false };
            if (t.remote_rtx == ssrc and t.remote_rtx != 0) return .{ .track = i, .rtx = true };
        }
        var pick: ?usize = null;
        if (mid_value) |mid| {
            for (tracks, 0..) |*t, i| {
                if (t.receives and std.mem.eql(u8, t.mid(), mid)) pick = i;
            }
        } else {
            // Без MID: годится, только если тип нагрузки встречается у одного канала с неизвестным потоком.
            var matches: usize = 0;
            for (tracks, 0..) |*t, i| {
                if (!t.receives) continue;
                const fits = (t.pt == pt and t.remote_ssrc == 0) or (t.rtx_pt == pt and t.remote_rtx == 0);
                if (fits) {
                    matches += 1;
                    pick = i;
                }
            }
            if (matches != 1) pick = null;
        }
        const i = pick orelse return null;
        const t = &l.tracks[i];
        if (t.pt == pt) {
            t.remote_ssrc = ssrc;
            return .{ .track = i, .rtx = false };
        }
        if (t.rtx_pt == pt) {
            t.remote_rtx = ssrc;
            return .{ .track = i, .rtx = true };
        }
        return null;
    }
};

/// Адреса, до которых дойдёт проверка: не пустой, не групповой, не широковещательный и не
/// локальный адрес IPv6 (отправка туда кончается EINVAL, а отладочная сборка считает это ошибкой).
pub fn routable(a: net.IpAddress) bool {
    switch (a) {
        .ip4 => |v| return v.bytes[0] != 0 and v.bytes[0] < 224 and v.port != 0,
        .ip6 => |v| {
            if (v.port == 0 or v.bytes[0] == 0xff) return false;
            if (v.bytes[0] == 0xfe and v.bytes[1] & 0xc0 == 0x80) return false; // fe80::/10
            for (v.bytes) |byte| if (byte != 0) return true;
            return false; // ::
        },
    }
}

/// IPv4 внутри IPv6 (::ffff:a.b.c.d) → обычный IPv4: адреса сравниваются одинаково, как бы ни пришли.
pub fn normalize(a: net.IpAddress) net.IpAddress {
    switch (a) {
        .ip4 => return a,
        .ip6 => |v| {
            const prefix = [12]u8{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff };
            if (std.mem.eql(u8, v.bytes[0..12], &prefix)) return .{ .ip4 = .{ .bytes = v.bytes[12..16].*, .port = v.port } };
            return .{ .ip6 = .{ .bytes = v.bytes, .port = v.port } };
        },
    }
}

pub fn mapped(a: net.Ip4Address) net.IpAddress {
    var b: [16]u8 = @splat(0);
    b[10] = 0xff;
    b[11] = 0xff;
    @memcpy(b[12..16], &a.bytes);
    return .{ .ip6 = .{ .bytes = b, .port = a.port } };
}

/// Знаки логина и пароля ICE (RFC 8839: буквы, цифры, «+» и «/»).
fn randomIceChars(io: Io, out: []u8) void {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var r: [64]u8 = undefined;
    io.random(r[0..out.len]);
    for (out, 0..) |*c, i| c.* = alphabet[r[i] & 63];
}

// ---------------------------------------------------------------------------

const chrome_offer = @embedFile("testdata/chrome_157_offer.sdp");

const TestHost = struct {
    sent: usize = 0,
    last_to: ?net.IpAddress = null,
    last: [600]u8 = undefined,
    last_len: usize = 0,
    messages: usize = 0,

    fn send(ctx: *anyopaque, to: net.IpAddress, data: []const u8) void {
        const h: *TestHost = @ptrCast(@alignCast(ctx));
        h.sent += 1;
        h.last_to = to;
        h.last_len = @min(data.len, h.last.len);
        @memcpy(h.last[0..h.last_len], data[0..h.last_len]);
    }
    fn message(ctx: *anyopaque, l: *Leg, ppid: u32, data: []const u8) void {
        _ = l;
        _ = ppid;
        _ = data;
        const h: *TestHost = @ptrCast(@alignCast(ctx));
        h.messages += 1;
    }
    fn host(h: *TestHost) Host {
        return .{ .ctx = h, .send = send, .message = message };
    }
};

fn testLeg(io: Io, th: *TestHost, id: *const dtls.Identity) !*Leg {
    const o = try sdp.parseOffer(chrome_offer);
    const l = try Leg.create(std.testing.allocator, io, th.host(), id, &srtp_gcm_first, "aaaaaaaaaaaaaaaa".*, "bbbbbbbbbbbbbbbb".*, &o, true, 1_000_000);
    errdefer l.destroy(std.testing.allocator);
    try l.describe(&o, &.{.{ .addr = .{ .ip4 = .{ .bytes = .{ 192, 168, 1, 20 }, .port = 40000 } }, .kind = .host }});
    return l;
}

test "leg: каналы и ответ по offer Chrome" {
    var threaded: Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    const id = try dtls.Identity.generate(io);
    var th: TestHost = .{};
    const l = try testLeg(io, &th, &id);
    defer l.destroy(std.testing.allocator);

    try std.testing.expectEqual(@as(usize, 4), l.track_count);
    const kinds = [_]sdp.Kind{ .audio, .video, .video, .audio };
    var seen_ssrc: [8]u32 = undefined;
    for (l.tracks[0..4], kinds, 0..) |*t, kind, i| {
        try std.testing.expectEqual(kind, t.kind);
        try std.testing.expect(t.sends and t.receives);
        try std.testing.expect(t.local_ssrc >= 0x100 and t.local_rtx >= 0x100);
        seen_ssrc[i * 2] = t.local_ssrc;
        seen_ssrc[i * 2 + 1] = t.local_rtx;
    }
    for (seen_ssrc, 0..) |a, i| for (seen_ssrc[i + 1 ..]) |b| try std.testing.expect(a != b);
    try std.testing.expectEqualStrings("1", l.tracks[1].mid());
    try std.testing.expectEqual(@as(u32, 1666214973), l.tracks[1].remote_ssrc);
    try std.testing.expectEqual(@as(u32, 262144), l.peer_max_message);
    try std.testing.expectEqualStrings("6043501147697230252", l.sessionId());
    try std.testing.expectEqual(@as(usize, 3), l.remote_count);

    // Ответ читается обратно и несёт SSRC узла для каждой секции.
    var text: [answer_max]u8 = undefined;
    const flipped = try std.fmt.bufPrint(&text, "{s}", .{l.answer()});
    while (std.mem.find(u8, flipped, "a=setup:passive")) |at| @memcpy(flipped[at..][0..15], "a=setup:actpass");
    const back = try sdp.parseOffer(flipped);
    try std.testing.expectEqualStrings(&l.local_ufrag, back.ufrag);
    for (l.tracks[0..4], 0..) |*t, i| try std.testing.expectEqual(t.local_ssrc, back.media[i].ssrc);
    try std.testing.expectEqual(l.tracks[2].local_rtx, back.media[2].rtx_ssrc);
    try std.testing.expectEqual(id.fingerprint, back.fingerprint);

    // Канал по SSRC, по MID и по типу нагрузки.
    try std.testing.expectEqual(Leg.Found{ .track = 0, .rtx = false }, l.findTrack(3557070677, 111, null).?);
    try std.testing.expectEqual(Leg.Found{ .track = 2, .rtx = true }, l.findTrack(2117691161, 97, null).?);
    try std.testing.expectEqual(@as(?Leg.Found, null), l.findTrack(5, 96, null)); // потоки обоих видеоканалов уже известны
    try std.testing.expectEqual(Leg.Found{ .track = 1, .rtx = false }, l.findTrack(5, 96, "1").?);
    try std.testing.expectEqual(@as(u32, 5), l.tracks[1].remote_ssrc); // запомнен
    try std.testing.expectEqual(@as(?Leg.Found, null), l.findTrack(6, 100, "1")); // чужой тип нагрузки
}

test "leg: проверки ICE" {
    var threaded: Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    const id = try dtls.Identity.generate(io);
    var th: TestHost = .{};
    const l = try testLeg(io, &th, &id);
    defer l.destroy(std.testing.allocator);
    const browser = try net.IpAddress.parse("203.0.113.5", 5000);

    // Ответ на проверку, которой не было, ничего не меняет.
    const Answer = struct {
        fn make(buf: *[256]u8, leg: *Leg, from: net.IpAddress, tid: [12]u8) stun.Message {
            var m = stun.Builder.init(buf, stun.binding_success, tid);
            m.addXorAddress(from);
            m.addIntegrity(leg.remotePwd());
            m.addFingerprint();
            return stun.parse(m.bytes()).?;
        }
    };
    var ab: [256]u8 = undefined;
    try std.testing.expectEqual(@as(?net.IpAddress, null), l.onBindingSuccess(&Answer.make(&ab, l, browser, @splat(0xaa)), 2_000_000));
    try std.testing.expectEqual(@as(usize, 0), l.valid_count);

    // Таймер шлёт проверку каждому кандидату; ответ на неё делает адрес годным и выбранным.
    l.tick(1_000_000);
    try std.testing.expectEqual(@as(usize, 3), th.sent);
    try std.testing.expectEqual(@as(usize, 3), l.check_count);
    const check = stun.parse(th.last[0..th.last_len]).?;
    try std.testing.expectEqual(stun.binding_request, check.msg_type);
    try std.testing.expect(check.checkIntegrity(l.remotePwd()));
    var want_user: [64]u8 = undefined;
    try std.testing.expectEqualStrings(try std.fmt.bufPrint(&want_user, "pU4I:{s}", .{&l.local_ufrag}), check.username.?);
    const to = l.checks[2].to;
    try std.testing.expect(l.onBindingSuccess(&Answer.make(&ab, l, to, l.checks[2].tid), 2_000_000).?.eql(&to));
    try std.testing.expect(l.isValid(to));
    try std.testing.expect(l.selected.?.eql(&to));

    // Запрос браузера: с верным паролем — ответ и новый годный адрес, с неверным — тишина.
    const Request = struct {
        fn make(buf: *[512]u8, leg: *Leg, pwd: []const u8, nominate: bool) stun.Message {
            var m = stun.Builder.init(buf, stun.binding_request, @splat(3));
            var user: [64]u8 = undefined;
            m.add(stun.attr_username, std.fmt.bufPrint(&user, "{s}:pU4I", .{&leg.local_ufrag}) catch unreachable);
            m.addU64(stun.attr_ice_controlling, 1);
            if (nominate) m.add(stun.attr_use_candidate, "");
            m.addIntegrity(pwd);
            m.addFingerprint();
            return stun.parse(m.bytes()).?;
        }
    };
    var rb: [512]u8 = undefined;
    const sent_before = th.sent;
    try std.testing.expect(!l.onBindingRequest(browser, &Request.make(&rb, l, "не тот пароль", false), 3_000_000));
    try std.testing.expectEqual(sent_before, th.sent);
    try std.testing.expect(l.onBindingRequest(browser, &Request.make(&rb, l, &l.local_pwd, true), 3_000_000));
    try std.testing.expect(l.isValid(browser));
    try std.testing.expect(l.selected.?.eql(&browser)); // браузер назначил этот путь
    try std.testing.expectEqual(sent_before + 2, th.sent); // ответ и встречная проверка
    try std.testing.expectEqual(@as(usize, 4), l.remote_count);

    // Перезапуск ICE: новые логин и пароль, прежний запрос больше не проходит, путь пока служит.
    const old_ufrag = l.local_ufrag;
    const o = try sdp.parseOffer(chrome_offer);
    try l.restartIce(&o, 4_000_000);
    try l.describe(&o, &.{});
    try std.testing.expect(!std.mem.eql(u8, &old_ufrag, &l.local_ufrag));
    try std.testing.expectEqual(@as(u32, 3), l.answer_version);
    try std.testing.expect(l.selected.?.eql(&browser));
    try std.testing.expectEqual(@as(usize, 3), l.remote_count);
    // После перезапуска проверки идут снова — и шли бы даже у уже соединённого плеча.
    const sent_before_restart = th.sent;
    l.tick(4_000_000);
    try std.testing.expectEqual(sent_before_restart + 3, th.sent);
    l.tls.state = .established;
    try std.testing.expect(l.checking(4_000_000 + recheck_us - 1));
    try std.testing.expect(!l.checking(4_000_000 + recheck_us));
    // Новый кандидат у соединённого плеча продлевает проверки, знакомый — нет.
    try std.testing.expect(l.addCandidate(try net.IpAddress.parse("198.51.100.7", 6000), 30_000_000));
    try std.testing.expect(l.checking(30_000_000 + recheck_us - 1));
    try std.testing.expect(!l.addCandidate(try net.IpAddress.parse("198.51.100.7", 6000), 60_000_000));
    try std.testing.expect(!l.checking(60_000_000));
    l.tls.state = .wait_hello;
    // Подлинный пакет медиа с другого проверенного адреса переводит плечо на этот путь.
    const other = l.remote[0];
    l.heardFrom(other, 4_500_000);
    try std.testing.expect(l.selected.?.eql(&other));
    l.heardFrom(browser, 4_600_000);

    // Плечо, которое за полминуты так и не соединилось, закрывается.
    l.tick(4_600_000 + idle_timeout_us + 1);
    try std.testing.expect(l.dead);
    try std.testing.expectEqualStrings("нет пути до браузера (ICE)", l.reason);
}

test "leg: отложенные сообщения вытесняют самые старые" {
    var o: Outbox = .{};
    o.push(51, "первое");
    o.push(53, "второе");
    try std.testing.expectEqual(@as(usize, 2), o.count);
    const big: [9000]u8 = @splat('x');
    o.push(51, &big);
    o.push(51, &big); // места на оба больших нет: уходит «первое», потом «второе»
    try std.testing.expectEqual(@as(usize, 1), o.count);
    try std.testing.expectEqual(@as(u32, 9000), o.items[0].len);
    try std.testing.expectEqual(@as(u32, 0), o.items[0].off);
    for (0..40) |i| o.push(51, &.{@intCast(i)});
    try std.testing.expectEqual(@as(usize, 32), o.count);
    try std.testing.expectEqual(@as(u8, 8), o.buf[o.items[0].off]); // первые восемь вытеснены вместе с большим
    try std.testing.expectEqual(@as(usize, 32), o.used);
    const huge: [17 * 1024]u8 = @splat('y');
    o.push(51, &huge); // больше всего ящика: не берём
    try std.testing.expectEqual(@as(usize, 32), o.count);
}

test "leg: нормализация адресов" {
    const m = mapped(.{ .bytes = .{ 203, 0, 113, 5 }, .port = 4000 });
    const n = normalize(m);
    try std.testing.expectEqualSlices(u8, &.{ 203, 0, 113, 5 }, &n.ip4.bytes);
    try std.testing.expectEqual(@as(u16, 4000), n.ip4.port);
    const v6 = try net.IpAddress.parse("2001:db8::1", 9);
    try std.testing.expect(normalize(v6).eql(&v6));
    try std.testing.expect(routable(v6));
    try std.testing.expect(routable(n));
    try std.testing.expect(!routable(try net.IpAddress.parse("fe80::1", 9)));
    try std.testing.expect(!routable(try net.IpAddress.parse("ff02::1", 9)));
    try std.testing.expect(!routable(try net.IpAddress.parse("::", 9)));
    try std.testing.expect(!routable(try net.IpAddress.parse("239.1.2.3", 9)));
    try std.testing.expect(!routable(try net.IpAddress.parse("0.0.0.0", 9)));
}
