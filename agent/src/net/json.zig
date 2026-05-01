const std = @import("std");
const metrics = @import("../collector/metrics.zig");

pub fn writeHello(writer: anytype, hello: metrics.HelloMessage) !void {
    try writer.writeAll("{\"type\":\"hello\"");
    try writeStringField(writer, "agent_id", hello.agent_id);
    try writeStringField(writer, "hostname", hello.hostname);
    try writeStringField(writer, "version", hello.version);
    try writeStringField(writer, "profile", hello.profile);
    try writeU32Field(writer, "interval_sec", hello.interval_seconds);
    try writer.writeAll(",\"platform\":{");
    try writeNamedString(writer, "os", hello.os);
    try writer.writeAll(",");
    try writeNamedString(writer, "arch", hello.arch);
    try writer.writeAll(",");
    try writeNamedString(writer, "distro", hello.distro);
    try writer.writeAll("},\"capabilities\":{");
    try writeNamedBool(writer, "loadavg", hello.capabilities.loadavg);
    try writer.writeAll(",");
    try writeNamedBool(writer, "swap", hello.capabilities.swap);
    try writer.writeAll(",");
    try writeNamedBool(writer, "process_count", hello.capabilities.process_count);
    try writer.writeAll(",");
    try writeNamedBool(writer, "websocket", hello.capabilities.websocket);
    try writer.writeAll(",");
    try writeNamedBool(writer, "tls", hello.capabilities.tls);
    try writer.writeAll(",");
    try writeNamedBool(writer, "self_update", hello.capabilities.self_update);
    try writer.writeAll("}}");
}

pub fn writeReport(writer: anytype, report: metrics.ReportMessage) !void {
    try writer.writeAll("{\"type\":\"report\"");
    try writeStringField(writer, "agent_id", report.agent_id);
    try writeI64Field(writer, "time", report.collected_at_unix);
    try writer.writeAll(",\"metrics\":{");
    try writeNamedString(writer, "os", report.os);
    try writer.writeAll(",");
    try writeNamedString(writer, "arch", report.arch);
    try writer.writeAll(",");
    try writeNamedString(writer, "distro", report.distro);
    try writer.writeAll(",");
    try writeNamedString(writer, "cpu_name", report.cpu_name);
    try writer.writeAll(",");
    try writeNamedU32(writer, "cpu_cores", report.cpu_cores);
    try writer.writeAll(",");
    try writeNamedString(writer, "gpu_name", report.gpu_name);
    try writer.writeAll(",");
    try writeNamedF64(writer, "cpu", report.cpu_percent);
    try writer.writeAll(",");
    try writeNamedU64(writer, "uptime_sec", report.uptime_seconds);
    try writer.writeAll(",");
    try writeNamedF64(writer, "load1", report.load1);
    try writer.writeAll(",");
    try writeNamedU64(writer, "memory_total", report.memory_total_bytes);
    try writer.writeAll(",");
    try writeNamedU64(writer, "memory_used", report.memory_used_bytes);
    try writer.writeAll(",");
    try writeNamedU64(writer, "swap_total", report.swap_total_bytes);
    try writer.writeAll(",");
    try writeNamedU64(writer, "swap_used", report.swap_used_bytes);
    try writer.writeAll(",");
    try writeNamedU32(writer, "process_count", report.process_count);
    try writer.writeAll(",");
    try writeNamedU32(writer, "connection_count", report.connection_count);
    try writer.writeAll(",");
    try writeNamedU64(writer, "disk_total", report.disk_total_bytes);
    try writer.writeAll(",");
    try writeNamedU64(writer, "disk_used", report.disk_used_bytes);
    try writer.writeAll(",");
    try writeNamedU64(writer, "network_up", report.network_up_bytes_per_sec);
    try writer.writeAll(",");
    try writeNamedU64(writer, "network_down", report.network_down_bytes_per_sec);
    try writer.writeAll(",");
    try writeNamedU64(writer, "network_total_up", report.network_total_up_bytes);
    try writer.writeAll(",");
    try writeNamedU64(writer, "network_total_down", report.network_total_down_bytes);
    try writer.writeAll("}}");
}

fn writeStringField(writer: anytype, name: []const u8, value: []const u8) !void {
    try writer.writeByte(',');
    try writeNamedString(writer, name, value);
}

fn writeU32Field(writer: anytype, name: []const u8, value: u32) !void {
    try writer.writeByte(',');
    try writeNamedU32(writer, name, value);
}

fn writeI64Field(writer: anytype, name: []const u8, value: i64) !void {
    try writer.writeByte(',');
    try writer.print("\"{s}\":{d}", .{ name, value });
}

fn writeNamedString(writer: anytype, name: []const u8, value: []const u8) !void {
    try writer.print("\"{s}\":", .{name});
    try writeEscapedString(writer, value);
}

fn writeNamedBool(writer: anytype, name: []const u8, value: bool) !void {
    try writer.print("\"{s}\":{s}", .{ name, if (value) "true" else "false" });
}

fn writeNamedU32(writer: anytype, name: []const u8, value: u32) !void {
    try writer.print("\"{s}\":{d}", .{ name, value });
}

fn writeNamedU64(writer: anytype, name: []const u8, value: u64) !void {
    try writer.print("\"{s}\":{d}", .{ name, value });
}

fn writeNamedF64(writer: anytype, name: []const u8, value: f64) !void {
    try writer.print("\"{s}\":{d:.3}", .{ name, value });
}

fn writeEscapedString(writer: anytype, value: []const u8) !void {
    try writer.writeByte('"');
    for (value) |byte| {
        switch (byte) {
            '\\' => try writer.writeAll("\\\\"),
            '"' => try writer.writeAll("\\\""),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            0...8, 11, 12, 14...31 => try writer.print("\\u{X:0>4}", .{@as(u16, byte)}),
            else => try writer.writeByte(byte),
        }
    }
    try writer.writeByte('"');
}

test "hello json is stable" {
    const hello: metrics.HelloMessage = .{
        .agent_id = "agent-1",
        .hostname = "host-1",
        .os = "linux",
        .arch = "x86_64",
        .distro = "Debian GNU/Linux 12",
        .version = "0.1.0",
        .profile = "full",
        .interval_seconds = 3,
        .capabilities = .{
            .loadavg = true,
            .swap = true,
            .process_count = true,
            .websocket = false,
            .tls = true,
            .self_update = true,
        },
    };

    var buffer: [512]u8 = undefined;
    var stream = std.io.fixedBufferStream(&buffer);
    try writeHello(stream.writer(), hello);

    try std.testing.expectEqualStrings(
        "{\"type\":\"hello\",\"agent_id\":\"agent-1\",\"hostname\":\"host-1\",\"version\":\"0.1.0\",\"profile\":\"full\",\"interval_sec\":3,\"platform\":{\"os\":\"linux\",\"arch\":\"x86_64\",\"distro\":\"Debian GNU/Linux 12\"},\"capabilities\":{\"loadavg\":true,\"swap\":true,\"process_count\":true,\"websocket\":false,\"tls\":true,\"self_update\":true}}",
        stream.getWritten(),
    );
}
