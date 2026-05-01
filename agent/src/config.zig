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
            .interval_seconds = try intervalFromEnv("DAOYI_AGENT_INTERVAL_SEC", 3),
            .profile = profile,
            .features = featuresForProfile(profile),
        };
    }

    pub fn deinit(self: *Config) void {
        self.allocator.free(self.endpoint);
        self.allocator.free(self.token);
        self.allocator.free(self.agent_id);
        self.allocator.free(self.hostname);
    }
};

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

fn intervalFromEnv(key: []const u8, fallback: u32) !u32 {
    const allocator = std.heap.page_allocator;
    const raw = std.process.getEnvVarOwned(allocator, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return fallback,
        else => return err,
    };
    defer allocator.free(raw);

    const value = try std.fmt.parseInt(u32, std.mem.trim(u8, raw, " \t\r\n"), 10);
    return std.math.clamp(value, 1, 3600);
}
