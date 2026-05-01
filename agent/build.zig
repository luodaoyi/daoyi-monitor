const std = @import("std");

const Profile = enum {
    full,
    small,
    tiny,
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const profile = b.option(Profile, "profile", "Agent feature profile: full, small, tiny") orelse .full;
    const version = b.option([]const u8, "version", "Agent semantic version") orelse "0.1.0";
    const strip = b.option(bool, "strip", "Strip debug symbols") orelse (optimize != .Debug);

    const options = b.addOptions();
    options.addOption([]const u8, "profile", @tagName(profile));
    options.addOption([]const u8, "version", version);

    const root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .strip = strip,
    });

    const exe = b.addExecutable(.{
        .name = "daoyi-agent",
        .root_module = root_module,
    });
    exe.root_module.addOptions("build_options", options);

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run the agent once or start it when a WebSocket endpoint is configured");
    run_step.dependOn(&run_cmd.step);

    const test_root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_root_module.addOptions("build_options", options);

    const unit_tests = b.addTest(.{
        .name = "daoyi-agent-tests",
        .root_module = test_root_module,
    });
    const run_tests = b.addRunArtifact(unit_tests);

    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}
