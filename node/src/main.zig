//! Звонилка — медиа-узел: пересылающий участник звонка (docs/PLAN.md, этап 3). Точка входа.
const std = @import("std");
const build_options = @import("build_options");
const room = @import("room.zig");
const node_mod = @import("node.zig");

const usage =
    \\Звонилка — медиа-узел: входит в комнату и пересылает звук и видео между участниками.
    \\
    \\  zvonilka-node <комната или ссылка на звонок> [ключи]
    \\
    \\Ключи:
    \\  --port N       порт UDP для медиа (по умолчанию любой свободный)
    \\  --ip A.B.C.D   внешний адрес узла, если его нет на сетевом интерфейсе (сервер за NAT 1:1)
    \\  --name ИМЯ     как узел называется в комнате (по умолчанию «Узел»)
    \\  --tcp          сигналинг без TLS: MQTT на порту 1883 (сообщения запечатаны и там)
    \\  --srtp cm|gcm  только один профиль SRTP: AES_CM_128_HMAC_SHA1_80 или AEAD_AES_128_GCM
    \\  --verbose      подробный журнал
    \\  --lose N       для проверки повторов: терять каждый N-й пакет видео
    \\  --version      версия
    \\
;

var running: ?*node_mod.Node = null;

fn onStopSignal(_: std.posix.SIG) callconv(.c) void {
    if (running) |n| n.stop();
}

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    const eql = std.mem.eql;
    var opts: node_mod.Options = .{ .room = "" };
    var room_text: []const u8 = "";
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        if (eql(u8, a, "--version") or eql(u8, a, "version")) {
            std.debug.print("zvonilka-node {s}\n", .{build_options.version});
            return;
        } else if (eql(u8, a, "--help") or eql(u8, a, "-h") or eql(u8, a, "help")) {
            return printUsage(0);
        } else if (eql(u8, a, "--verbose")) {
            opts.verbose = true;
        } else if (eql(u8, a, "--tcp")) {
            opts.transport = .tcp;
        } else if (i + 1 < args.len and eql(u8, a, "--lose")) {
            i += 1;
            opts.lose_every = std.fmt.parseInt(u32, args[i], 10) catch return printUsage(2);
        } else if (i + 1 < args.len and eql(u8, a, "--port")) {
            i += 1;
            opts.port = std.fmt.parseInt(u16, args[i], 10) catch return printUsage(2);
        } else if (i + 1 < args.len and eql(u8, a, "--ip")) {
            i += 1;
            const addr = std.Io.net.IpAddress.parse(args[i], 0) catch return printUsage(2);
            if (addr != .ip4) return printUsage(2);
            opts.public_ip = addr.ip4.bytes;
        } else if (i + 1 < args.len and eql(u8, a, "--name")) {
            i += 1;
            opts.name = args[i];
        } else if (i + 1 < args.len and eql(u8, a, "--srtp")) {
            i += 1;
            opts.srtp = if (eql(u8, args[i], "cm")) .cm else if (eql(u8, args[i], "gcm")) .gcm else return printUsage(2);
        } else if (a.len > 0 and a[0] != '-' and room_text.len == 0) {
            room_text = a;
        } else {
            return printUsage(2);
        }
    }
    var room_buf: [room.max_len]u8 = undefined;
    opts.room = room.parse(&room_buf, room_text);
    if (opts.room.len == 0) return printUsage(2);
    if (!std.unicode.utf8ValidateSlice(opts.name) or opts.name.len > 80) return printUsage(2);

    const n = try node_mod.Node.create(init.gpa, init.io, opts);
    running = n;
    // Ctrl+C и остановка службой: узел успевает попрощаться с комнатой.
    const act: std.posix.Sigaction = .{ .handler = .{ .handler = onStopSignal }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(.INT, &act, null);
    std.posix.sigaction(.TERM, &act, null);
    n.log("комната «{s}»", .{opts.room});
    n.run() catch |e| {
        n.log("узел остановлен: {t}", .{e});
        std.process.exit(1);
    };
    // Потоки сигналинга ещё живы и держат память: выходим, не дожидаясь их.
    std.process.exit(0);
}

fn printUsage(code: u8) void {
    std.debug.print("{s}", .{usage});
    if (code != 0) std.process.exit(code);
}
