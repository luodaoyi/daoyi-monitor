const config = @import("../config.zig");

pub const HelloMessage = struct {
    agent_id: []const u8,
    hostname: []const u8,
    os: []const u8,
    arch: []const u8,
    version: []const u8,
    profile: []const u8,
    interval_seconds: u32,
    capabilities: config.FeatureSet,
};

pub const ReportMessage = struct {
    agent_id: []const u8,
    collected_at_unix: i64,
    uptime_seconds: u64,
    load1: f64,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    swap_total_bytes: u64,
    swap_used_bytes: u64,
    process_count: u32,
};

pub fn buildHello(cfg: *const config.Config, version: []const u8) HelloMessage {
    return .{
        .agent_id = cfg.agent_id,
        .hostname = cfg.hostname,
        .os = config.targetOsName(),
        .arch = config.targetArchName(),
        .version = version,
        .profile = @tagName(cfg.profile),
        .interval_seconds = cfg.interval_seconds,
        .capabilities = cfg.features,
    };
}
