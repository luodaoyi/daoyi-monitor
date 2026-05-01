const std = @import("std");
const build_options = @import("build_options");
const config = @import("config.zig");
const linux = @import("collector/linux.zig");
const metrics = @import("collector/metrics.zig");
const json = @import("net/json.zig");
const websocket = @import("net/websocket.zig");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();

    const allocator = gpa.allocator();
    const profile = try config.parseProfile(build_options.profile);

    var cfg = try config.Config.init(allocator, profile);
    defer cfg.deinit();
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    cfg.applyArgs(args) catch |err| switch (err) {
        error.HelpRequested => {
            var stdout = std.fs.File.stdout().deprecatedWriter();
            try stdout.writeAll("Usage: daoyi-agent --endpoint URL --token TOKEN [--interval SEC] [--agent-id ID]\n");
            return;
        },
        else => return err,
    };

    const hello = metrics.buildHello(&cfg, build_options.version);

    var hello_buffer: [1536]u8 = undefined;
    const hello_payload = try encodeHello(&hello_buffer, hello);
    var collector_state = linux.CollectorState{};

    if (isWebSocketEndpoint(cfg.endpoint)) {
        if (cfg.token.len == 0) return error.MissingAgentToken;
        var client = try websocket.Client.connect(allocator, cfg.endpoint, cfg.token);
        defer client.close();

        try client.sendText(hello_payload);
        while (true) {
            const report = try linux.collect(allocator, &cfg, &collector_state);
            var report_buffer: [2048]u8 = undefined;
            const report_payload = try encodeReport(&report_buffer, report);
            try client.sendText(report_payload);
            std.Thread.sleep(@as(u64, cfg.interval_seconds) * std.time.ns_per_s);
        }
        return;
    }

    const report = try linux.collect(allocator, &cfg, &collector_state);
    var report_buffer: [2048]u8 = undefined;
    const report_payload = try encodeReport(&report_buffer, report);

    var stdout = std.fs.File.stdout().deprecatedWriter();
    try writeLine(&stdout, hello_payload, report_payload);
}

fn writeLine(
    stdout: anytype,
    hello_payload: []const u8,
    report_payload: []const u8,
) !void {
    try stdout.writeAll(hello_payload);
    try stdout.writeByte('\n');

    try stdout.writeAll(report_payload);
    try stdout.writeByte('\n');
}

fn encodeHello(buffer: []u8, hello: metrics.HelloMessage) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    try json.writeHello(stream.writer(), hello);
    return stream.getWritten();
}

fn encodeReport(buffer: []u8, report: metrics.ReportMessage) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    try json.writeReport(stream.writer(), report);
    return stream.getWritten();
}

fn isWebSocketEndpoint(endpoint: []const u8) bool {
    return std.mem.startsWith(u8, endpoint, "ws://") or std.mem.startsWith(u8, endpoint, "wss://");
}
