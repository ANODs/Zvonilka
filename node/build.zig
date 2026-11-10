const std = @import("std");

/// Версия задаётся в одном месте — build.zig.zon.
const zon: struct {
    name: @EnumLiteral(),
    version: []const u8,
    fingerprint: u64,
    minimum_zig_version: []const u8,
    paths: []const []const u8,
} = @import("build.zig.zon");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const options = b.addOptions();
    options.addOption([]const u8, "version", zon.version);

    const root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    root.addOptions("build_options", options);

    // Один бинарник без зависимостей: узел запускают где угодно.
    const exe = b.addExecutable(.{ .name = "zvonilka-node", .root_module = root });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    run_cmd.addPassthruArgs();
    b.step("run", "Запустить узел: zig build run -- <комната>").dependOn(&run_cmd.step);

    const tests_mod = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
    });
    tests_mod.addOptions("build_options", options);
    const tests = b.addTest(.{ .root_module = tests_mod });
    b.step("test", "Юнит-тесты модулей узла").dependOn(&b.addRunArtifact(tests).step);
}
