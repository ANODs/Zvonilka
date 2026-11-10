//! Адреса IPv4 этого компьютера: их узел объявляет браузерам как свои кандидаты.
//! Одного «адреса по умолчанию» мало: с включённым VPN маршрут наружу идёт через туннель,
//! а телефон в той же сети Wi-Fi достанет узел только по адресу сетевой карты.
//! В std такого перечисления нет: на macOS и BSD — getifaddrs, на Linux — ioctl SIOCGIFCONF.
const std = @import("std");
const builtin = @import("builtin");
const net = std.Io.net;

pub const max = 6;

/// Заполняет `out` адресами, пригодными для связи: без петли (127/8) и без самоназначенных
/// (169.254/16). Первым идёт адрес, с которого пакет ушёл бы наружу.
pub fn addresses(io: std.Io, out: *[max][4]u8) usize {
    var count: usize = 0;
    if (routed(io)) |a| add(out, &count, a);
    var all: [16][4]u8 = undefined;
    const found = switch (builtin.os.tag) {
        .macos, .ios, .freebsd, .netbsd, .openbsd, .dragonfly => bsd.list(&all),
        .linux => linux.list(&all),
        else => 0,
    };
    for (all[0..found]) |a| add(out, &count, a);
    return count;
}

fn add(out: *[max][4]u8, count: *usize, a: [4]u8) void {
    if (!usable(a) or count.* == max) return;
    for (out[0..count.*]) |have| if (std.mem.eql(u8, &have, &a)) return;
    out[count.*] = a;
    count.* += 1;
}

fn usable(a: [4]u8) bool {
    if (a[0] == 0 or a[0] == 127 or a[0] >= 224) return false;
    return !(a[0] == 169 and a[1] == 254);
}

/// С какого адреса пакет ушёл бы наружу: сокет UDP привязывается к внешнему адресу, но
/// ничего не шлёт.
fn routed(io: std.Io) ?[4]u8 {
    const probe = net.IpAddress.parse("192.0.2.1", 9) catch unreachable;
    const s = probe.connect(io, .{ .mode = .dgram }) catch return null;
    defer s.close(io);
    return switch (s.socket.address) {
        .ip4 => |a| a.bytes,
        .ip6 => null,
    };
}

const bsd = struct {
    const sockaddr = extern struct { len: u8, family: u8, data: [14]u8 };
    const ifaddrs = extern struct {
        next: ?*ifaddrs,
        name: ?[*:0]const u8,
        flags: c_uint,
        addr: ?*const sockaddr,
        netmask: ?*const sockaddr,
        dstaddr: ?*const sockaddr,
        data: ?*anyopaque,
    };
    extern "c" fn getifaddrs(list: *?*ifaddrs) c_int;
    extern "c" fn freeifaddrs(list: ?*ifaddrs) void;
    const af_inet = 2;
    const iff_up = 0x1;

    fn list(out: *[16][4]u8) usize {
        var head: ?*ifaddrs = null;
        if (getifaddrs(&head) != 0) return 0;
        defer freeifaddrs(head);
        var n: usize = 0;
        var it = head;
        while (it) |ifa| : (it = ifa.next) {
            const addr = ifa.addr orelse continue;
            if (addr.family != af_inet or ifa.flags & iff_up == 0 or n == out.len) continue;
            // sockaddr_in: порт (2 байта), затем адрес.
            out[n] = addr.data[2..6].*;
            n += 1;
        }
        return n;
    }
};

const linux = struct {
    const os = std.os.linux;

    fn list(out: *[16][4]u8) usize {
        const rc = os.socket(os.AF.INET, os.SOCK.DGRAM | os.SOCK.CLOEXEC, 0);
        if (os.errno(rc) != .SUCCESS) return 0;
        const fd: os.fd_t = @intCast(rc);
        defer _ = os.close(fd);
        var reqs: [32]os.ifreq = undefined;
        // struct ifconf: длина буфера в байтах и указатель на него; ядро пишет, сколько занято.
        var conf: extern struct { len: i32, buf: usize } = .{ .len = @sizeOf(@TypeOf(reqs)), .buf = @intFromPtr(&reqs) };
        if (os.errno(os.ioctl(fd, os.SIOCGIFCONF, @intFromPtr(&conf))) != .SUCCESS) return 0;
        const got = @as(usize, @intCast(@max(conf.len, 0))) / @sizeOf(os.ifreq);
        var n: usize = 0;
        for (reqs[0..@min(got, reqs.len)]) |*r| {
            if (r.ifru.addr.family != os.AF.INET or n == out.len) continue;
            out[n] = r.ifru.addr.data[2..6].*;
            n += 1;
        }
        return n;
    }
};

test "netif: у компьютера есть адреса, и петли среди них нет" {
    var threaded: std.Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    var out: [max][4]u8 = undefined;
    const n = addresses(threaded.io(), &out);
    for (out[0..n], 0..) |a, i| {
        try std.testing.expect(usable(a));
        for (out[0..i]) |b| try std.testing.expect(!std.mem.eql(u8, &a, &b));
    }
    try std.testing.expect(!usable(.{ 127, 0, 0, 1 }));
    try std.testing.expect(!usable(.{ 169, 254, 10, 1 }));
    try std.testing.expect(!usable(.{ 0, 0, 0, 0 }));
    try std.testing.expect(!usable(.{ 239, 1, 2, 3 }));
    try std.testing.expect(usable(.{ 192, 168, 0, 10 }));
}
