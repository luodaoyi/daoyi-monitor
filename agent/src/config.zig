const std = @import("std");
const builtin = @import("builtin");

pub const BuildProfile = enum {
    full,
    small,
    tiny,
};

pub const FeatureSet = struct {
    loadavg: bool,
    swap: bool,
    process_count: bool,
    websocket: bool,
    tls: bool,
    self_update: bool,
};

pub const Config = struct {
    allocator: std.mem.Allocator,
    endpoint: []const u8,
    token: []const u8,
    agent_id: []const u8,
    hostname: []const u8,
    distro: []const u8,
    cpu_name: []const u8,
    cpu_cores: u32,
    gpu_name: []const u8,
    interval_seconds: u32,
    profile: BuildProfile,
    features: FeatureSet,

    pub fn init(allocator: std.mem.Allocator, profile: BuildProfile) !Config {
        return .{
            .allocator = allocator,
            .endpoint = try envOrDefault(allocator, "DAOYI_AGENT_ENDPOINT", ""),
            .token = try envOrDefault(allocator, "DAOYI_AGENT_TOKEN", ""),
            .agent_id = try envOrDefault(allocator, "DAOYI_AGENT_ID", "demo-agent"),
            .hostname = try detectHostname(allocator),
            .distro = try detectDistro(allocator),
            .cpu_name = try detectCpuName(allocator),
            .cpu_cores = try detectCpuCores(allocator),
            .gpu_name = try detectGpuName(allocator),
            .interval_seconds = try intervalFromEnv("DAOYI_AGENT_INTERVAL_SEC", 3),
            .profile = profile,
            .features = featuresForProfile(profile),
        };
    }

    pub fn applyArgs(self: *Config, args: []const []const u8) !void {
        var index: usize = 1;
        while (index < args.len) {
            const key = args[index];
            if (std.mem.eql(u8, key, "--endpoint")) {
                const value = try argValue(args, &index, key);
                self.allocator.free(self.endpoint);
                self.endpoint = try self.allocator.dupe(u8, value);
            } else if (std.mem.eql(u8, key, "--token")) {
                const value = try argValue(args, &index, key);
                self.allocator.free(self.token);
                self.token = try self.allocator.dupe(u8, value);
            } else if (std.mem.eql(u8, key, "--agent-id")) {
                const value = try argValue(args, &index, key);
                self.allocator.free(self.agent_id);
                self.agent_id = try self.allocator.dupe(u8, value);
            } else if (std.mem.eql(u8, key, "--interval")) {
                const value = try argValue(args, &index, key);
                self.interval_seconds = try parseInterval(value, 3);
            } else if (std.mem.eql(u8, key, "--help") or std.mem.eql(u8, key, "-h")) {
                return error.HelpRequested;
            } else {
                return error.UnknownArgument;
            }
            index += 1;
        }
    }

    pub fn deinit(self: *Config) void {
        self.allocator.free(self.endpoint);
        self.allocator.free(self.token);
        self.allocator.free(self.agent_id);
        self.allocator.free(self.hostname);
        self.allocator.free(self.distro);
        self.allocator.free(self.cpu_name);
        self.allocator.free(self.gpu_name);
    }
};

fn argValue(args: []const []const u8, index: *usize, key: []const u8) ![]const u8 {
    if (index.* + 1 >= args.len) {
        std.debug.print("missing value for {s}\n", .{key});
        return error.MissingArgumentValue;
    }
    index.* += 1;
    return args[index.*];
}

pub fn parseProfile(raw: []const u8) !BuildProfile {
    inline for (std.meta.tags(BuildProfile)) |tag| {
        if (std.mem.eql(u8, raw, @tagName(tag))) {
            return tag;
        }
    }
    return error.InvalidProfile;
}

pub fn featuresForProfile(profile: BuildProfile) FeatureSet {
    return switch (profile) {
        .full => .{
            .loadavg = true,
            .swap = true,
            .process_count = true,
            .websocket = true,
            .tls = true,
            .self_update = true,
        },
        .small => .{
            .loadavg = true,
            .swap = true,
            .process_count = false,
            .websocket = true,
            .tls = true,
            .self_update = false,
        },
        .tiny => .{
            .loadavg = false,
            .swap = false,
            .process_count = false,
            .websocket = false,
            .tls = false,
            .self_update = false,
        },
    };
}

pub fn targetOsName() []const u8 {
    return @tagName(builtin.target.os.tag);
}

pub fn targetArchName() []const u8 {
    return @tagName(builtin.target.cpu.arch);
}

fn envOrDefault(allocator: std.mem.Allocator, key: []const u8, fallback: []const u8) ![]const u8 {
    return std.process.getEnvVarOwned(allocator, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => allocator.dupe(u8, fallback),
        else => err,
    };
}

fn detectHostname(allocator: std.mem.Allocator) ![]const u8 {
    const keys = [_][]const u8{ "HOSTNAME", "COMPUTERNAME" };
    inline for (keys) |key| {
        if (std.process.getEnvVarOwned(allocator, key)) |value| {
            return value;
        } else |err| switch (err) {
            error.EnvironmentVariableNotFound => {},
            else => return err,
        }
    }

    return allocator.dupe(u8, "unknown-host");
}

fn detectDistro(allocator: std.mem.Allocator) ![]const u8 {
    if (builtin.os.tag != .linux) {
        return allocator.dupe(u8, targetOsName());
    }

    const raw = readSmallAbsoluteFile(allocator, "/etc/os-release") catch
        readSmallAbsoluteFile(allocator, "/usr/lib/os-release") catch
        return allocator.dupe(u8, "linux");
    defer allocator.free(raw);

    if (osReleaseValue(raw, "PRETTY_NAME")) |value| return allocator.dupe(u8, value);
    if (osReleaseValue(raw, "NAME")) |value| return allocator.dupe(u8, value);
    if (osReleaseValue(raw, "ID")) |value| return allocator.dupe(u8, value);
    return allocator.dupe(u8, "linux");
}

fn readSmallAbsoluteFile(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    return readAbsoluteFileMax(allocator, path, 4096);
}

fn readAbsoluteFileMax(allocator: std.mem.Allocator, path: []const u8, max_bytes: usize) ![]u8 {
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();
    return file.readToEndAlloc(allocator, max_bytes);
}

fn osReleaseValue(raw: []const u8, key: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |line| {
        if (line.len <= key.len or !std.mem.startsWith(u8, line, key) or line[key.len] != '=') {
            continue;
        }
        var value = std.mem.trim(u8, line[key.len + 1 ..], " \t\r\n");
        if (value.len >= 2 and value[0] == '"' and value[value.len - 1] == '"') {
            value = value[1 .. value.len - 1];
        }
        return value;
    }
    return null;
}

fn detectCpuName(allocator: std.mem.Allocator) ![]const u8 {
    if (builtin.os.tag != .linux) return allocator.dupe(u8, "");
    const raw = readAbsoluteFileMax(allocator, "/proc/cpuinfo", 64 * 1024) catch return allocator.dupe(u8, "");
    defer allocator.free(raw);
    if (cpuInfoValue(raw, "model name")) |value| return allocator.dupe(u8, value);
    if (cpuInfoValue(raw, "Hardware")) |value| return allocator.dupe(u8, value);
    if (cpuInfoValue(raw, "Processor")) |value| return allocator.dupe(u8, value);
    return allocator.dupe(u8, "");
}

fn detectCpuCores(allocator: std.mem.Allocator) !u32 {
    if (builtin.os.tag != .linux) return 0;
    const raw = readAbsoluteFileMax(allocator, "/proc/cpuinfo", 64 * 1024) catch return 0;
    defer allocator.free(raw);

    var count: u32 = 0;
    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, std.mem.trimLeft(u8, line, " \t"), "processor")) {
            count += 1;
        }
    }
    return count;
}

fn cpuInfoValue(raw: []const u8, key: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        const name = std.mem.trim(u8, line[0..colon], " \t\r\n");
        if (!std.mem.eql(u8, name, key)) continue;
        const value = std.mem.trim(u8, line[colon + 1 ..], " \t\r\n");
        return if (value.len > 0) value else null;
    }
    return null;
}

fn detectGpuName(allocator: std.mem.Allocator) ![]const u8 {
    if (builtin.os.tag != .linux) return allocator.dupe(u8, "");

    var dir = std.fs.openDirAbsolute("/proc/driver/nvidia/gpus", .{ .iterate = true }) catch return allocator.dupe(u8, "");
    defer dir.close();

    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        if (entry.kind != .directory) continue;
        var path_buffer: [256]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buffer, "/proc/driver/nvidia/gpus/{s}/information", .{entry.name}) catch continue;
        const raw = readAbsoluteFileMax(allocator, path, 4096) catch continue;
        defer allocator.free(raw);
        if (gpuInfoValue(raw, "Model")) |value| return allocator.dupe(u8, value);
    }

    return allocator.dupe(u8, "");
}

fn gpuInfoValue(raw: []const u8, key: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        const name = std.mem.trim(u8, line[0..colon], " \t\r\n");
        if (!std.mem.eql(u8, name, key)) continue;
        const value = std.mem.trim(u8, line[colon + 1 ..], " \t\r\n");
        return if (value.len > 0) value else null;
    }
    return null;
}

fn intervalFromEnv(key: []const u8, fallback: u32) !u32 {
    const allocator = std.heap.page_allocator;
    const raw = std.process.getEnvVarOwned(allocator, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return fallback,
        else => return err,
    };
    defer allocator.free(raw);

    return parseInterval(raw, fallback);
}

fn parseInterval(raw: []const u8, fallback: u32) !u32 {
    const value = std.fmt.parseInt(u32, std.mem.trim(u8, raw, " \t\r\n"), 10) catch return fallback;
    return std.math.clamp(value, 1, 3600);
}
