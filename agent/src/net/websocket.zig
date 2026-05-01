const std = @import("std");

const websocket_guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const agent_path = "/ws/agent";

pub const Client = struct {
    transport: Transport,
    closed: bool = false,

    const Transport = union(enum) {
        plain: std.net.Stream,
        http: HttpTransport,
    };

    const HttpTransport = struct {
        allocator: std.mem.Allocator,
        client: *std.http.Client,
        request: std.http.Client.Request,
    };

    pub fn connect(
        allocator: std.mem.Allocator,
        endpoint: []const u8,
        token: []const u8,
    ) !Client {
        const uri = try std.Uri.parse(endpoint);
        if (std.mem.eql(u8, uri.scheme, "wss")) {
            return connectHttp(allocator, uri, token);
        }

        if (!std.mem.eql(u8, uri.scheme, "ws")) {
            return error.UnsupportedScheme;
        }

        var host_buffer: [std.Uri.host_name_max]u8 = undefined;
        const host = try uri.getHost(&host_buffer);
        const port = uri.port orelse 80;
        const stream = try std.net.tcpConnectToHost(allocator, host, port);
        errdefer stream.close();

        var raw_key: [16]u8 = undefined;
        std.crypto.random.bytes(&raw_key);

        var request_key_buffer: [24]u8 = undefined;
        const request_key = std.base64.standard.Encoder.encode(&request_key_buffer, &raw_key);

        try sendHandshake(stream, host, port, token, request_key);

        var expected_accept_buffer: [28]u8 = undefined;
        const expected_accept = computeAcceptKey(request_key, &expected_accept_buffer);
        try readAndValidateHandshake(stream, expected_accept);

        return .{ .transport = .{ .plain = stream } };
    }

    pub fn sendText(self: *Client, payload: []const u8) !void {
        var mask_key: [4]u8 = undefined;
        std.crypto.random.bytes(&mask_key);
        switch (self.transport) {
            .plain => |stream| try writeClientFrame(stream, .text, payload, mask_key),
            .http => |*transport| {
                const connection = transport.request.connection orelse return error.ConnectionClosed;
                try writeClientFrame(connection.writer(), .text, payload, mask_key);
                try connection.flush();
            },
        }
    }

    pub fn close(self: *Client) void {
        if (!self.closed) {
            var payload: [2]u8 = undefined;
            std.mem.writeInt(u16, payload[0..2], 1000, .big);

            var mask_key: [4]u8 = undefined;
            std.crypto.random.bytes(&mask_key);
            switch (self.transport) {
                .plain => |stream| writeClientFrame(stream, .close, &payload, mask_key) catch {},
                .http => |*transport| {
                    if (transport.request.connection) |connection| {
                        writeClientFrame(connection.writer(), .close, &payload, mask_key) catch {};
                        connection.end() catch {};
                    }
                },
            }
            self.closed = true;
        }

        switch (self.transport) {
            .plain => |stream| stream.close(),
            .http => |*transport| {
                transport.request.deinit();
                transport.client.deinit();
                transport.allocator.destroy(transport.client);
            },
        }
    }
};

const Opcode = enum(u4) {
    text = 0x1,
    close = 0x8,
};

fn sendHandshake(
    stream: std.net.Stream,
    host: []const u8,
    port: u16,
    token: []const u8,
    request_key: []const u8,
) !void {
    var host_header_buffer: [std.Uri.host_name_max + 8]u8 = undefined;
    const host_header = try formatHostHeader(&host_header_buffer, host, port);

    var request_buffer: [1024]u8 = undefined;
    const request = try std.fmt.bufPrint(
        &request_buffer,
        "GET {s} HTTP/1.1\r\n" ++
            "Host: {s}\r\n" ++
            "Upgrade: websocket\r\n" ++
            "Connection: Upgrade\r\n" ++
            "Sec-WebSocket-Key: {s}\r\n" ++
            "Sec-WebSocket-Version: 13\r\n" ++
            "Authorization: Bearer {s}\r\n" ++
            "\r\n",
        .{ agent_path, host_header, request_key, token },
    );

    try stream.writeAll(request);
}

fn connectHttp(
    allocator: std.mem.Allocator,
    uri: std.Uri,
    token: []const u8,
) !Client {
    var raw_key: [16]u8 = undefined;
    std.crypto.random.bytes(&raw_key);

    var request_key_buffer: [24]u8 = undefined;
    const request_key = std.base64.standard.Encoder.encode(&request_key_buffer, &raw_key);

    var authorization_buffer: [512]u8 = undefined;
    const authorization = try std.fmt.bufPrint(&authorization_buffer, "Bearer {s}", .{token});

    const headers = [_]std.http.Header{
        .{ .name = "Upgrade", .value = "websocket" },
        .{ .name = "Sec-WebSocket-Key", .value = request_key },
        .{ .name = "Sec-WebSocket-Version", .value = "13" },
    };

    const http_client = try allocator.create(std.http.Client);
    errdefer allocator.destroy(http_client);
    http_client.* = .{
        .allocator = allocator,
        .read_buffer_size = 4096,
        .write_buffer_size = 1024,
    };
    errdefer http_client.deinit();

    var request = try http_client.request(.GET, uri, .{
        .keep_alive = false,
        .redirect_behavior = .unhandled,
        .headers = .{
            .authorization = .{ .override = authorization },
            .connection = .{ .override = "Upgrade" },
            .user_agent = .{ .override = "daoyi-agent" },
            .accept_encoding = .omit,
        },
        .extra_headers = &headers,
    });
    errdefer request.deinit();

    try request.sendBodiless();
    var redirect_buffer: [0]u8 = .{};
    const response = try request.receiveHead(&redirect_buffer);

    if (response.head.status != .switching_protocols) {
        return error.WebSocketHandshakeRejected;
    }

    var expected_accept_buffer: [28]u8 = undefined;
    const expected_accept = computeAcceptKey(request_key, &expected_accept_buffer);
    try validateHandshakeHeaders(response.head.bytes, expected_accept);

    return .{
        .transport = .{
            .http = .{
                .allocator = allocator,
                .client = http_client,
                .request = request,
            },
        },
    };
}

fn formatHostHeader(buffer: []u8, host: []const u8, port: u16) ![]const u8 {
    const needs_brackets =
        std.mem.indexOfScalar(u8, host, ':') != null and
        !(std.mem.startsWith(u8, host, "[") and std.mem.endsWith(u8, host, "]"));

    if (needs_brackets) {
        return std.fmt.bufPrint(buffer, "[{s}]:{d}", .{ host, port });
    }

    return std.fmt.bufPrint(buffer, "{s}:{d}", .{ host, port });
}

fn computeAcceptKey(request_key: []const u8, buffer: []u8) []const u8 {
    var hash = std.crypto.hash.Sha1.init(.{});
    hash.update(request_key);
    hash.update(websocket_guid);

    var digest: [20]u8 = undefined;
    hash.final(&digest);
    return std.base64.standard.Encoder.encode(buffer, &digest);
}

fn readAndValidateHandshake(stream: std.net.Stream, expected_accept: []const u8) !void {
    var response_buffer: [4096]u8 = undefined;
    var used: usize = 0;

    while (std.mem.indexOf(u8, response_buffer[0..used], "\r\n\r\n") == null) {
        if (used == response_buffer.len) {
            return error.HandshakeResponseTooLarge;
        }

        const read_count = try stream.read(response_buffer[used..]);
        if (read_count == 0) {
            return error.ConnectionClosedDuringHandshake;
        }
        used += read_count;
    }

    const header_end = std.mem.indexOf(u8, response_buffer[0..used], "\r\n\r\n").? + 4;
    try validateHandshakeResponse(response_buffer[0..header_end], expected_accept);
}

fn validateHandshakeResponse(response: []const u8, expected_accept: []const u8) !void {
    var lines = std.mem.splitSequence(u8, response, "\r\n");
    const status_line = lines.next() orelse return error.InvalidHandshakeResponse;

    if (!std.mem.startsWith(u8, status_line, "HTTP/1.1 101") and
        !std.mem.startsWith(u8, status_line, "HTTP/1.0 101"))
    {
        return error.WebSocketHandshakeRejected;
    }

    try validateHandshakeHeaderLines(&lines, expected_accept);
}

fn validateHandshakeHeaders(response: []const u8, expected_accept: []const u8) !void {
    var lines = std.mem.splitSequence(u8, response, "\r\n");
    if (std.mem.startsWith(u8, response, "HTTP/")) {
        _ = lines.next() orelse return error.InvalidHandshakeResponse;
    }

    try validateHandshakeHeaderLines(&lines, expected_accept);
}

fn validateHandshakeHeaderLines(
    lines: *std.mem.SplitIterator(u8, .sequence),
    expected_accept: []const u8,
) !void {
    var saw_upgrade = false;
    var saw_connection = false;
    var saw_accept = false;

    while (lines.next()) |line| {
        if (line.len == 0) break;

        const separator = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        const name = std.mem.trim(u8, line[0..separator], " \t");
        const value = std.mem.trim(u8, line[separator + 1 ..], " \t");

        if (std.ascii.eqlIgnoreCase(name, "Upgrade")) {
            saw_upgrade = std.ascii.eqlIgnoreCase(value, "websocket");
        } else if (std.ascii.eqlIgnoreCase(name, "Connection")) {
            saw_connection = headerHasToken(value, "Upgrade");
        } else if (std.ascii.eqlIgnoreCase(name, "Sec-WebSocket-Accept")) {
            saw_accept = std.mem.eql(u8, value, expected_accept);
        }
    }

    if (!saw_upgrade or !saw_connection or !saw_accept) {
        return error.InvalidHandshakeResponse;
    }
}

fn headerHasToken(value: []const u8, token: []const u8) bool {
    var parts = std.mem.splitScalar(u8, value, ',');
    while (parts.next()) |part| {
        if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, part, " \t"), token)) {
            return true;
        }
    }
    return false;
}

fn writeClientFrame(
    writer: anytype,
    opcode: Opcode,
    payload: []const u8,
    mask_key: [4]u8,
) !void {
    var header: [10]u8 = undefined;
    var header_len: usize = 2;

    header[0] = @as(u8, 0x80) | @as(u8, @intFromEnum(opcode));
    if (payload.len <= 125) {
        header[1] = 0x80 | @as(u8, @intCast(payload.len));
    } else if (payload.len <= std.math.maxInt(u16)) {
        header[1] = 0x80 | 126;
        std.mem.writeInt(u16, header[2..4], @as(u16, @intCast(payload.len)), .big);
        header_len = 4;
    } else {
        header[1] = 0x80 | 127;
        std.mem.writeInt(u64, header[2..10], @as(u64, @intCast(payload.len)), .big);
        header_len = 10;
    }

    try writer.writeAll(header[0..header_len]);
    try writer.writeAll(mask_key[0..]);

    var masked_chunk: [256]u8 = undefined;
    var offset: usize = 0;
    while (offset < payload.len) {
        const chunk_len = @min(masked_chunk.len, payload.len - offset);
        for (payload[offset..][0..chunk_len], 0..) |byte, index| {
            masked_chunk[index] = byte ^ mask_key[(offset + index) % mask_key.len];
        }
        try writer.writeAll(masked_chunk[0..chunk_len]);
        offset += chunk_len;
    }
}

test "accept key matches RFC 6455 example" {
    var buffer: [28]u8 = undefined;
    const accept = computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==", &buffer);

    try std.testing.expectEqualStrings(
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        accept,
    );
}

test "handshake validation accepts 101 upgrade" {
    try validateHandshakeResponse(
        "HTTP/1.1 101 Switching Protocols\r\n" ++
            "Upgrade: websocket\r\n" ++
            "Connection: keep-alive, Upgrade\r\n" ++
            "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n" ++
            "\r\n",
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
}

test "client text frame is masked" {
    var buffer: [64]u8 = undefined;
    var stream = std.io.fixedBufferStream(&buffer);

    try writeClientFrame(stream.writer(), .text, "Hi", .{ 0x37, 0xfa, 0x21, 0x3d });

    const expected = [_]u8{
        0x81,
        0x82,
        0x37,
        0xfa,
        0x21,
        0x3d,
        'H' ^ 0x37,
        'i' ^ 0xfa,
    };

    try std.testing.expectEqualSlices(u8, &expected, stream.getWritten());
}
