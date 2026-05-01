const config = @import("../config.zig");

pub const HelloMessage = struct {
    agent_id: []const u8,
    hostname: []const u8,
    os: []const u8,
    arch: []const u8,
    distro: []const u8,
    version: []const u8,
    profile: []const u8,
    interval_seconds: u32,
    capabilities: config.FeatureSet,
};

pub const ReportMessage = struct {
    agent_id: []const u8,
    os: []const u8,
    arch: []const u8,
    distro: []const u8,
    collected_at_unix: i64,
    cpu_percent: f64,
    uptime_seconds: u64,
    load1: f64,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    swap_total_bytes: u64,
    swap_used_bytes: u64,
    process_count: u32,
    disk_total_bytes: u64,
    disk_used_bytes: u64,
    network_up_bytes_per_sec: u64,
    network_down_bytes_per_sec: u64,
    network_total_up_bytes: u64,
    network_total_down_bytes: u64,
};

pub fn buildHello(cfg: *const config.Config, version: []const u8) HelloMessage {
    return .{
        .agent_id = cfg.agent_id,
        .hostname = cfg.hostname,
        .os = config.targetOsName(),
        .arch = config.targetArchName(),
        .distro = cfg.distro,
        .version = version,
        .profile = @tagName(cfg.profile),
        .interval_seconds = cfg.interval_seconds,
        .capabilities = cfg.features,
    };
}
