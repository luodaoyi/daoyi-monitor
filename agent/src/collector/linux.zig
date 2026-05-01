const std = @import("std");
const builtin = @import("builtin");
const config = @import("../config.zig");
const metrics = @import("metrics.zig");

const LoadSnapshot = struct {
    load1: f64,
    process_count: u32,
};

const MemorySnapshot = struct {
    total_bytes: u64,
    used_bytes: u64,
    swap_total_bytes: u64,
    swap_used_bytes: u64,
};

pub fn collect(allocator: std.mem.Allocator, cfg: *const config.Config) !metrics.ReportMessage {
    var report = metrics.ReportMessage{
        .agent_id = cfg.agent_id,
        .collected_at_unix = std.time.timestamp(),
        .uptime_seconds = 0,
        .load1 = 0,
        .memory_total_bytes = 0,
        .memory_used_bytes = 0,
        .swap_total_bytes = 0,
        .swap_used_bytes = 0,
        .process_count = 0,
    };

    if (builtin.os.tag != .linux) {
        report.uptime_seconds = 1;
        return report;
    }

    const uptime_raw = try readProcFile(allocator, "/proc/uptime", 256);
    defer allocator.free(uptime_raw);
    report.uptime_seconds = try parseUptime(uptime_raw);

    if (cfg.features.loadavg or cfg.features.process_count) {
        const loadavg_raw = try readProcFile(allocator, "/proc/loadavg", 256);
        defer allocator.free(loadavg_raw);
        const load = try parseLoadAvg(loadavg_raw);
        if (cfg.features.loadavg) {
            report.load1 = load.load1;
        }
        if (cfg.features.process_count) {
            report.process_count = load.process_count;
        }
    }

    const meminfo_raw = try readProcFile(allocator, "/proc/meminfo", 4096);
    defer allocator.free(meminfo_raw);
    const mem = try parseMemInfo(meminfo_raw, cfg.features.swap);
    report.memory_total_bytes = mem.total_bytes;
    report.memory_used_bytes = mem.used_bytes;
    report.swap_total_bytes = mem.swap_total_bytes;
    report.swap_used_bytes = mem.swap_used_bytes;

    return report;
}

fn readProcFile(allocator: std.mem.Allocator, path: []const u8, max_bytes: usize) ![]u8 {
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();
    return file.readToEndAlloc(allocator, max_bytes);
}

fn parseUptime(raw: []const u8) !u64 {
    const first = std.mem.trim(u8, std.mem.sliceTo(raw, ' '), " \t\r\n");
    const uptime_seconds = try std.fmt.parseFloat(f64, first);
    return @intFromFloat(@max(uptime_seconds, 0));
}

fn parseLoadAvg(raw: []const u8) !LoadSnapshot {
    var parts = std.mem.tokenizeAny(u8, raw, " \t\r\n");
    const load1_raw = parts.next() orelse return error.InvalidLoadAverage;
    _ = parts.next() orelse return error.InvalidLoadAverage;
    _ = parts.next() orelse return error.InvalidLoadAverage;
    const running_total = parts.next() orelse return error.InvalidLoadAverage;

    var process_parts = std.mem.splitScalar(u8, running_total, '/');
    _ = process_parts.next() orelse return error.InvalidLoadAverage;
    const total_raw = process_parts.next() orelse return error.InvalidLoadAverage;

    return .{
        .load1 = try std.fmt.parseFloat(f64, load1_raw),
        .process_count = try std.fmt.parseInt(u32, total_raw, 10),
    };
}

fn parseMemInfo(raw: []const u8, include_swap: bool) !MemorySnapshot {
    var mem_total_kib: u64 = 0;
    var mem_available_kib: u64 = 0;
    var swap_total_kib: u64 = 0;
    var swap_free_kib: u64 = 0;

    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "MemTotal:")) {
            mem_total_kib = try parseMemInfoValue(line["MemTotal:".len..]);
        } else if (std.mem.startsWith(u8, line, "MemAvailable:")) {
            mem_available_kib = try parseMemInfoValue(line["MemAvailable:".len..]);
        } else if (include_swap and std.mem.startsWith(u8, line, "SwapTotal:")) {
            swap_total_kib = try parseMemInfoValue(line["SwapTotal:".len..]);
        } else if (include_swap and std.mem.startsWith(u8, line, "SwapFree:")) {
            swap_free_kib = try parseMemInfoValue(line["SwapFree:".len..]);
        }
    }

    if (mem_total_kib == 0) {
        return error.InvalidMemInfo;
    }

    const memory_used_kib = mem_total_kib - @min(mem_total_kib, mem_available_kib);
    const swap_used_kib = swap_total_kib - @min(swap_total_kib, swap_free_kib);

    return .{
        .total_bytes = mem_total_kib * 1024,
        .used_bytes = memory_used_kib * 1024,
        .swap_total_bytes = swap_total_kib * 1024,
        .swap_used_bytes = swap_used_kib * 1024,
    };
}

fn parseMemInfoValue(raw: []const u8) !u64 {
    var parts = std.mem.tokenizeAny(u8, raw, " \t\r\n");
    const value = parts.next() orelse return error.InvalidMemInfo;
    return std.fmt.parseInt(u64, value, 10);
}

test "parse loadavg uses total processes" {
    const parsed = try parseLoadAvg("0.15 0.20 0.22 1/233 12345\n");
    try std.testing.expectEqual(@as(u32, 233), parsed.process_count);
    try std.testing.expectApproxEqAbs(@as(f64, 0.15), parsed.load1, 0.0001);
}

test "parse meminfo computes used memory" {
    const parsed = try parseMemInfo(
        \\MemTotal:       16384 kB
        \\MemAvailable:    4096 kB
        \\SwapTotal:       8192 kB
        \\SwapFree:        2048 kB
        \\
    , true);

    try std.testing.expectEqual(@as(u64, 16384 * 1024), parsed.total_bytes);
    try std.testing.expectEqual(@as(u64, 12288 * 1024), parsed.used_bytes);
    try std.testing.expectEqual(@as(u64, 8192 * 1024), parsed.swap_total_bytes);
    try std.testing.expectEqual(@as(u64, 6144 * 1024), parsed.swap_used_bytes);
}
