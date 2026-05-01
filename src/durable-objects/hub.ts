import type { Env, HubSocketAttachment, HubSocketRole } from "../types";

type SocketWithAttachment = WebSocket & {
  serializeAttachment(value: HubSocketAttachment): void;
  deserializeAttachment(): HubSocketAttachment | null;
};

type HubInboundMessage =
  | {
      type: "hello" | "report" | "ping";
      [key: string]: unknown;
    }
  | Record<string, unknown>;

const ONLINE_WINDOW_SECONDS = 240;
const HISTORY_BUCKET_SECONDS = 180;
const HISTORY_SLOT_COUNT = 30 * 24 * 60 * 60 / HISTORY_BUCKET_SECONDS;

export class Hub {
  private readonly decoder = new TextDecoder();
  private readonly latestByAgent = new Map<string, Record<string, unknown>>();
  private readonly lastPersistedBucketByAgent = new Map<string, number>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws/agent" || url.pathname === "/ws/admin") {
      return this.handleWebSocketUpgrade(request, url);
    }

    if (url.pathname === "/status") {
      return Response.json({
        agentConnections: this.state.getWebSockets("agent").length,
        adminConnections: this.state.getWebSockets("admin").length,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const socket = ws as SocketWithAttachment;
    const attachment = socket.deserializeAttachment();
    const text = this.toText(message);

    if (!attachment || text === null) {
      return;
    }

    const payload = this.parseMessage(text);

    if (attachment.role === "agent") {
      await this.handleAgentMessage(socket, attachment, payload);
      return;
    }

    await this.handleAdminMessage(socket, attachment, payload);
  }

  webSocketClose(ws: WebSocket): void {
    const socket = ws as SocketWithAttachment;
    const attachment = socket.deserializeAttachment();

    if (!attachment) {
      return;
    }

    if (attachment.role === "agent" && attachment.agentId) {
      this.latestByAgent.delete(attachment.agentId);
      this.broadcastToAdmins({
        type: "offline",
        agent_id: attachment.agentId,
        at: new Date().toISOString(),
      });
      return;
    }

    this.broadcastToAdmins({
      type: "peer_disconnected",
      role: attachment.role,
      agentId: attachment.agentId ?? null,
      adminId: attachment.adminId ?? null,
      at: new Date().toISOString(),
    });
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    const socket = ws as SocketWithAttachment;
    const attachment = socket.deserializeAttachment();

    if (!attachment) {
      return;
    }

    this.broadcastToAdmins({
      type: "peer_error",
      role: attachment.role,
      agentId: attachment.agentId ?? null,
      adminId: attachment.adminId ?? null,
      error: error instanceof Error ? error.message : "unknown_error",
      at: new Date().toISOString(),
    });
  }

  private async handleWebSocketUpgrade(
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const role: HubSocketRole =
      url.pathname === "/ws/agent" ? "agent" : "admin";
    const identity =
      role === "agent"
        ? await this.authenticateAgent(request)
        : await this.authenticateAdmin(request);

    if (!identity.ok) {
      return new Response(identity.message, { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const socket = server as SocketWithAttachment;
    const attachment: HubSocketAttachment = {
      role,
      connectedAt: new Date().toISOString(),
      agentId: role === "agent" ? identity.id : undefined,
      adminId: role === "admin" ? identity.id : undefined,
    };

    this.state.acceptWebSocket(server, [role]);
    socket.serializeAttachment(attachment);
    server.send(
      JSON.stringify({
        type: "connected",
        role,
        connectedAt: attachment.connectedAt,
      }),
    );

    if (role === "admin") {
      server.send(
        JSON.stringify({
          type: "snapshot",
          agents: await this.getAgentSnapshot(),
          at: new Date().toISOString(),
        }),
      );
    } else {
      this.broadcastToAdmins({
        type: "agent_connected",
        agentId: attachment.agentId ?? null,
        at: attachment.connectedAt,
      });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleAgentMessage(
    ws: SocketWithAttachment,
    attachment: HubSocketAttachment,
    payload: HubInboundMessage,
  ): Promise<void> {
    const type = typeof payload.type === "string" ? payload.type : "message";

    if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
      return;
    }

    if (type === "hello" || type === "report") {
      const now = Math.floor(Date.now() / 1000);
      const agentId = attachment.agentId;
      if (!agentId) return;
      const latest = snapshotFromAgentMessage(agentId, payload, now);
      this.latestByAgent.set(agentId, latest);
      await this.persistAgentSampleIfNeeded(agentId, now, payload);
      this.broadcastToAdmins({
        type: "latest",
        data: latest,
      });
      ws.send(JSON.stringify({ type: "ack", at: now }));
      return;
    }

    ws.send(JSON.stringify({ type: "error", message: "unknown message type" }));
  }

  private async handleAdminMessage(
    ws: SocketWithAttachment,
    _attachment: HubSocketAttachment,
    payload: HubInboundMessage,
  ): Promise<void> {
    const type = typeof payload.type === "string" ? payload.type : "message";

    if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
      return;
    }

    if (type === "subscribe") {
      ws.send(
        JSON.stringify({
          type: "snapshot",
          agents: await this.getAgentSnapshot(),
          at: new Date().toISOString(),
        }),
      );
      return;
    }

    ws.send(
      JSON.stringify({
        type: "ack",
        event: type,
        at: new Date().toISOString(),
      }),
    );
  }

  private broadcastToAdmins(payload: Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);

    for (const socket of this.state.getWebSockets("admin")) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(serialized);
      }
    }
  }

  private parseMessage(raw: string): HubInboundMessage {
    try {
      return JSON.parse(raw) as HubInboundMessage;
    } catch {
      return { type: "raw", raw };
    }
  }

  private toText(message: string | ArrayBuffer): string | null {
    if (typeof message === "string") {
      return message;
    }

    if (message instanceof ArrayBuffer) {
      return this.decoder.decode(message);
    }

    return null;
  }

  private async authenticateAgent(
    request: Request,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const token = bearerToken(request);
    if (!token) return { ok: false, message: "missing token" };
    const row = await this.env.DB.prepare(
      `SELECT id FROM agents WHERE token_hash = ?1 AND enabled = 1 LIMIT 1`,
    )
      .bind(await sha256Hex(token))
      .first<{ id: string }>();
    if (!row) return { ok: false, message: "invalid token" };
    return { ok: true, id: row.id };
  }

  private async authenticateAdmin(
    request: Request,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const token = getCookie(request, "daoyi_session");
    if (!token) return { ok: false, message: "missing session" };
    const now = Math.floor(Date.now() / 1000);
    const row = await this.env.DB.prepare(
      `SELECT user_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2 LIMIT 1`,
    )
      .bind(await sha256Hex(token), now)
      .first<{ user_id: string }>();
    if (!row) return { ok: false, message: "invalid session" };
    return { ok: true, id: row.user_id };
  }

  private async getAgentSnapshot(): Promise<unknown[]> {
    const rows = await this.env.DB.prepare(
      `
        SELECT a.id, a.name, a.enabled, s.last_seen, s.payload_json
        FROM agents a
        LEFT JOIN agent_status s ON s.agent_id = a.id
        WHERE a.hidden = 0
        ORDER BY a.weight ASC, a.created_at ASC
      `,
    ).all<SnapshotRow>();
    const merged = new Map<string, Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      const snapshot = snapshotFromRow(row);
      merged.set(row.id, snapshot);
    }

    const connectedAgentIds = new Set(this.getConnectedAgentIds());

    for (const [agentId, latest] of this.latestByAgent) {
      if (!connectedAgentIds.has(agentId)) continue;
      const existing = merged.get(agentId) ?? {};
      merged.set(agentId, { ...existing, ...latest });
    }

    for (const agentId of connectedAgentIds) {
      const existing = merged.get(agentId) ?? {
        id: agentId,
        agent_id: agentId,
        name: agentId,
      };
      merged.set(agentId, {
        ...existing,
        online: true,
        last_seen: Math.floor(Date.now() / 1000),
      });
    }

    return [...merged.values()];
  }

  private async getAgentForSnapshot(agentId: string): Promise<unknown | null> {
    const row = await this.env.DB.prepare(
      `
        SELECT a.id, a.name, a.enabled, s.last_seen, s.payload_json
        FROM agents a
        LEFT JOIN agent_status s ON s.agent_id = a.id
        WHERE a.id = ?1
        LIMIT 1
      `,
    )
      .bind(agentId)
      .first<SnapshotRow>();
    return row ? snapshotFromRow(row) : null;
  }

  private async persistAgentSampleIfNeeded(
    agentId: string,
    now: number,
    payload: HubInboundMessage,
  ): Promise<void> {
    const bucket = Math.floor(now / HISTORY_BUCKET_SECONDS);
    if (this.lastPersistedBucketByAgent.get(agentId) === bucket) {
      return;
    }

    this.lastPersistedBucketByAgent.set(agentId, bucket);
    const bucketStart = bucket * HISTORY_BUCKET_SECONDS;
    const bucketSlot = bucket % HISTORY_SLOT_COUNT;
    const payloadJson = JSON.stringify(payload);

    await this.env.DB.batch([
      this.env.DB.prepare(
        `
          INSERT INTO agent_status (agent_id, last_seen, payload_json, updated_at)
          VALUES (?1, ?2, ?3, ?2)
          ON CONFLICT(agent_id) DO UPDATE SET
            last_seen = excluded.last_seen,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `,
      ).bind(agentId, now, payloadJson),
      this.env.DB.prepare(
        `
          INSERT INTO agent_history (agent_id, bucket_slot, bucket_start, payload_json, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(agent_id, bucket_slot) DO UPDATE SET
            bucket_start = excluded.bucket_start,
            payload_json = excluded.payload_json,
            created_at = excluded.created_at
        `,
      ).bind(agentId, bucketSlot, bucketStart, payloadJson, now),
    ]);
  }

  private getConnectedAgentIds(): string[] {
    const ids: string[] = [];
    for (const socket of this.state.getWebSockets("agent")) {
      const attachment = (socket as SocketWithAttachment).deserializeAttachment();
      if (attachment?.agentId) ids.push(attachment.agentId);
    }
    return ids;
  }
}

type SnapshotRow = {
  id: string;
  name: string;
  enabled: number;
  last_seen: number | null;
  payload_json: string | null;
};

function snapshotFromRow(row: SnapshotRow): Record<string, unknown> {
  const lastSeen = row.last_seen ?? 0;
  let metrics: Record<string, unknown> | undefined;
  if (row.payload_json) {
    try {
      metrics = extractMetrics(JSON.parse(row.payload_json));
    } catch {
      metrics = undefined;
    }
  }
  return {
    agent_id: row.id,
    id: row.id,
    name: row.name,
    online: Boolean(row.enabled) && lastSeen > 0 && Math.floor(Date.now() / 1000) - lastSeen <= ONLINE_WINDOW_SECONDS,
    last_seen: lastSeen,
    metrics,
  };
}

function snapshotFromAgentMessage(
  agentId: string,
  payload: HubInboundMessage,
  now: number,
): Record<string, unknown> {
  return {
    id: agentId,
    agent_id: agentId,
    online: true,
    last_seen: now,
    metrics: extractMetrics(payload),
  };
}

function extractMetrics(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const nested = payload.metrics;
  return isRecord(nested) ? nested : payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
