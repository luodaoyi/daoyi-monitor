import { Hono } from "hono";
import { Hub } from "./durable-objects/hub";
import type { AgentDto, ApiResponse, Env, InitStatus, UserDto } from "./types";

const app = new Hono<{ Bindings: Env }>();
const SESSION_COOKIE = "daoyi_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ONLINE_WINDOW_SECONDS = 240;
const SECRET_MASK = "********";
const PBKDF2_ITERATIONS = 100_000;

app.onError((err, c) => {
  return c.json<ApiResponse<null>>(
    {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: err instanceof Error ? err.message : "Request failed.",
      },
    },
    400,
  );
});

app.get("/", (c) =>
  c.json<ApiResponse<{ service: string; ws: string[] }>>({
    ok: true,
    data: {
      service: "daoyi-monitor-worker",
      ws: ["/ws/agent", "/ws/admin"],
    },
  }),
);

app.get("/api/init/status", async (c) => {
  const status = await getInitStatus(c.env);

  return c.json<ApiResponse<InitStatus>>({
    ok: true,
    data: status,
  });
});

app.get("/api/public/agents", async (c) => {
  const rows = await c.env.DB.prepare(
    `
      SELECT
        a.id, a.name, a.enabled, a.hidden, a.weight, a.group_name, a.tags,
        a.remark, a.public_remark, a.token_preview, a.created_at, a.updated_at,
        s.last_seen, s.payload_json
      FROM agents a
      LEFT JOIN agent_status s ON s.agent_id = a.id
      WHERE a.enabled = 1 AND a.hidden = 0
      ORDER BY a.weight ASC, a.created_at ASC
    `,
  ).all<AgentRow>();

  return json((rows.results ?? []).map(publicAgentFromRow));
});

app.post("/api/init", async (c) => initAdmin(c.env, c.req.raw));
app.post("/api/init/admin", async (c) => initAdmin(c.env, c.req.raw));

app.post("/api/auth/login", async (c) => {
  const body = await readJson<{ username?: string; password?: string }>(
    c.req.raw,
  );
  const username = requireString(body.username, "username", 50);
  const password = requireString(body.password, "password", 200);
  const user = await c.env.DB.prepare(
    `SELECT id, username, password_hash, password_salt FROM users WHERE username = ?1 LIMIT 1`,
  )
    .bind(username)
    .first<{
      id: string;
      username: string;
      password_hash: string;
      password_salt: string;
    }>();

  if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
    return error("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  }

  const token = randomToken(32);
  const now = nowSeconds();
  const sessionId = randomId();
  await c.env.DB.prepare(
    `
      INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at, created_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    `,
  )
    .bind(
      sessionId,
      user.id,
      await sha256Hex(token),
      c.req.header("user-agent") ?? "",
      c.req.header("cf-connecting-ip") ?? "",
      now + SESSION_TTL_SECONDS,
      now,
    )
    .run();

  return json<UserDto>(
    { id: user.id, username: user.username },
    200,
    sessionCookie(token, now + SESSION_TTL_SECONDS),
  );
});

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c.req.raw, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`)
      .bind(await sha256Hex(token))
      .run();
  }
  return json<null>(null, 200, clearSessionCookie());
});

app.get("/api/auth/me", async (c) => {
  const user = await getCurrentUser(c.env, c.req.raw);
  return json<UserDto | null>(user);
});

app.get("/api/settings/notifications", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  return json(maskNotificationConfig(await readNotificationConfig(c.env)));
});

app.put("/api/settings/notifications", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  const body = await readJson<Partial<NotificationConfig>>(c.req.raw);
  const existing = await readNotificationConfig(c.env);
  const next = normalizeNotificationConfig(body, existing);
  await writeSetting(c.env, "notification_config", JSON.stringify(next));
  return json(maskNotificationConfig(next));
});

app.post("/api/settings/notifications/test", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  const config = await readNotificationConfig(c.env);
  if (!config.enabled) return error("NOTIFICATION_DISABLED", "通知未启用", 400);
  await sendNotifications(config, "Daoyi-Monitor test notification.");
  return json({ sent: true });
});

app.get("/api/agents", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  const rows = await c.env.DB.prepare(
    `
      SELECT
        a.id, a.name, a.enabled, a.hidden, a.weight, a.group_name, a.tags,
        a.remark, a.public_remark, a.token_preview, a.created_at, a.updated_at,
        s.last_seen, s.payload_json
      FROM agents a
      LEFT JOIN agent_status s ON s.agent_id = a.id
      ORDER BY a.weight ASC, a.created_at ASC
    `,
  ).all<AgentRow>();

  return json((rows.results ?? []).map(agentFromRow));
});

app.post("/api/agents", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  const body = await readJson<Partial<AgentUpdateInput>>(c.req.raw);
  const name = requireString(body.name, "name", 100);
  const enabled = body.enabled === undefined ? 1 : boolToInt(body.enabled);
  const hidden = body.hidden === undefined ? 0 : boolToInt(body.hidden);
  const weight = body.weight === undefined ? 0 : clampInteger(body.weight, "weight", -100000, 100000);
  const groupName = body.group_name === undefined ? null : nullableString(body.group_name, "group_name", 100);
  const tags = body.tags === undefined ? null : nullableString(body.tags, "tags", 500);
  const remark = body.remark === undefined ? null : nullableString(body.remark, "remark", 2000);
  const publicRemark = body.public_remark === undefined ? null : nullableString(body.public_remark, "public_remark", 2000);
  const token = randomToken(32);
  const id = randomId();
  const now = nowSeconds();

  await c.env.DB.prepare(
    `
      INSERT INTO agents (
        id, name, token_hash, token_preview, enabled, hidden, weight, group_name,
        tags, remark, public_remark, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
    `,
  )
    .bind(
      id,
      name,
      await sha256Hex(token),
      previewToken(token),
      enabled,
      hidden,
      weight,
      groupName,
      tags,
      remark,
      publicRemark,
      now,
    )
    .run();

  return json<{ agent: AgentDto; token: string }>(
    {
      agent: agentFromRow({
        id,
        name,
        enabled,
        hidden,
        weight,
        group_name: groupName,
        tags,
        remark,
        public_remark: publicRemark,
        token_preview: previewToken(token),
        created_at: now,
        updated_at: now,
        last_seen: null,
        payload_json: null,
      }),
      token,
    },
    201,
  );
});

app.get("/api/agents/:id", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  const row = await getAgentRow(c.env, c.req.param("id"));
  if (!row) return error("NOT_FOUND", "节点不存在", 404);
  return json(agentFromRow(row));
});

app.get("/api/agents/:id/history", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  const id = c.req.param("id");
  const row = await getAgentRow(c.env, id);
  if (!row) return error("NOT_FOUND", "节点不存在", 404);

  const hours = clampInteger(
    Number(c.req.query("hours") ?? 24),
    "hours",
    1,
    24 * 30,
  );
  const from = nowSeconds() - hours * 60 * 60;
  const history = await c.env.DB.prepare(
    `
      SELECT bucket_start, payload_json
      FROM agent_history
      WHERE agent_id = ?1 AND bucket_start >= ?2
      ORDER BY bucket_start ASC
    `,
  )
    .bind(id, from)
    .all<{ bucket_start: number; payload_json: string }>();

  return json(
    (history.results ?? []).map((item) => ({
      bucket_start: Number(item.bucket_start),
      metrics: extractMetrics(safeJsonParse(item.payload_json)),
    })),
  );
});

app.patch("/api/agents/:id", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  const id = c.req.param("id");
  const existing = await getAgentRow(c.env, id);
  if (!existing) return error("NOT_FOUND", "节点不存在", 404);
  const body = await readJson<Partial<AgentUpdateInput>>(c.req.raw);
  const now = nowSeconds();
  const next = {
    name: body.name === undefined ? existing.name : requireString(body.name, "name", 100),
    enabled: body.enabled === undefined ? Number(existing.enabled) : boolToInt(body.enabled),
    hidden: body.hidden === undefined ? Number(existing.hidden) : boolToInt(body.hidden),
    weight: body.weight === undefined ? Number(existing.weight) : clampInteger(body.weight, "weight", -100000, 100000),
    group_name: body.group_name === undefined ? existing.group_name : nullableString(body.group_name, "group_name", 100),
    tags: body.tags === undefined ? existing.tags : nullableString(body.tags, "tags", 500),
    remark: body.remark === undefined ? existing.remark : nullableString(body.remark, "remark", 2000),
    public_remark: body.public_remark === undefined ? existing.public_remark : nullableString(body.public_remark, "public_remark", 2000),
  };

  await c.env.DB.prepare(
    `
      UPDATE agents
      SET name = ?2, enabled = ?3, hidden = ?4, weight = ?5, group_name = ?6,
          tags = ?7, remark = ?8, public_remark = ?9, updated_at = ?10
      WHERE id = ?1
    `,
  )
    .bind(
      id,
      next.name,
      next.enabled,
      next.hidden,
      next.weight,
      next.group_name,
      next.tags,
      next.remark,
      next.public_remark,
      now,
    )
    .run();

  const row = await getAgentRow(c.env, id);
  return json(agentFromRow(row!));
});

app.delete("/api/agents/:id", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  const id = c.req.param("id");
  const row = await getAgentRow(c.env, id);
  if (!row) return error("NOT_FOUND", "节点不存在", 404);
  const body = await readOptionalJson<{ confirm?: string }>(c.req.raw);
  if (body?.confirm !== id && body?.confirm !== row.name) {
    return error("CONFIRMATION_REQUIRED", "请输入节点 ID 或名称确认删除", 400);
  }
  await c.env.DB.prepare(`DELETE FROM agents WHERE id = ?1`)
    .bind(id)
    .run();
  return json<null>(null);
});

app.post("/api/agents/:id/token/rotate", async (c) => {
  const user = await requireAdmin(c.env, c.req.raw);
  if (!user.ok) return user.response;
  const id = c.req.param("id");
  const row = await getAgentRow(c.env, id);
  if (!row) return error("NOT_FOUND", "节点不存在", 404);
  const token = randomToken(32);
  await c.env.DB.prepare(
    `UPDATE agents SET token_hash = ?2, token_preview = ?3, updated_at = ?4 WHERE id = ?1`,
  )
    .bind(id, await sha256Hex(token), previewToken(token), nowSeconds())
    .run();
  const next = await getAgentRow(c.env, id);
  return json<{ agent: AgentDto; token: string }>({ agent: agentFromRow(next!), token });
});

async function initAdmin(env: Env, request: Request): Promise<Response> {
  const status = await getInitStatus(env);

  if (!status.schemaReady) {
    return error("SCHEMA_NOT_READY", "Apply D1 migrations before initialization.", 503);
  }

  if (status.initialized) {
    return error("ALREADY_INITIALIZED", "Worker has already been initialized.", 409);
  }

  const body = await readJson<{ username?: string; password?: string }>(request);
  const username = requireString(body.username, "username", 50);
  const password = requireString(body.password, "password", 200);
  const now = nowSeconds();
  const userId = randomId();
  const passwordHash = await hashPassword(password);
  const initializedAt = new Date().toISOString();

  await env.DB.prepare(
    `
      INSERT INTO users (id, username, password_hash, password_salt, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    `,
  )
    .bind(userId, username, passwordHash.hash, passwordHash.salt, now)
    .run();

  await env.DB.prepare(
    `
      INSERT INTO app_meta (key, value, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
  )
    .bind("initialized_at", initializedAt, now)
    .run();

  return json<InitStatus>(
    {
      schemaReady: true,
      initialized: true,
      initializedAt,
    },
    201,
  );
}

app.get("/ws/agent", async (c) => proxyToHub(c.env, c.req.raw));
app.get("/ws/admin", async (c) => proxyToHub(c.env, c.req.raw));

app.notFound((c) =>
  c.json<ApiResponse<null>>(
    {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
      },
    },
    404,
  ),
);

async function getInitStatus(env: Env): Promise<InitStatus> {
  const table = await env.DB.prepare(
    `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?1
      LIMIT 1
    `,
  )
    .bind("app_meta")
    .first<{ name: string }>();

  if (!table) {
    return {
      schemaReady: false,
      initialized: false,
      initializedAt: null,
    };
  }

  const meta = await env.DB.prepare(
    `
      SELECT value
      FROM app_meta
      WHERE key = ?1
      LIMIT 1
    `,
  )
    .bind("initialized_at")
    .first<{ value: string }>();

  return {
    schemaReady: true,
    initialized: meta !== null,
    initializedAt: meta?.value ?? null,
  };
}

async function proxyToHub(env: Env, request: Request): Promise<Response> {
  const id = env.HUB.idFromName("global");
  const stub = env.HUB.get(id);

  return stub.fetch(request);
}

type AgentRow = {
  id: string;
  name: string;
  enabled: number;
  hidden: number;
  weight: number;
  group_name: string | null;
  tags: string | null;
  remark: string | null;
  public_remark: string | null;
  token_preview: string;
  created_at: number;
  updated_at: number;
  last_seen: number | null;
  payload_json: string | null;
};

type AgentUpdateInput = {
  name: string;
  enabled: boolean;
  hidden: boolean;
  weight: number;
  group_name: string | null;
  tags: string | null;
  remark: string | null;
  public_remark: string | null;
};

type NotificationConfig = {
  enabled: boolean;
  webhook_enabled: boolean;
  webhook_url: string | null;
  telegram_enabled: boolean;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
};

type NotificationState = {
  offline: Record<string, number>;
};

function json<T>(data: T, status = 200, headers?: HeadersInit): Response {
  return Response.json({ ok: true, data } satisfies ApiResponse<T>, {
    status,
    headers,
  });
}

function error(code: string, message: string, status = 400): Response {
  return Response.json(
    { ok: false, error: { code, message } } satisfies ApiResponse<never>,
    { status },
  );
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Invalid JSON");
  }
}

async function readOptionalJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function requireString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`${name} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new Error(`${name} is invalid`);
  }
  return trimmed;
}

function nullableString(value: unknown, name: string, max: number): string | null {
  if (value === null || value === "") return null;
  return requireString(value, name, max);
}

function nullableStringLoose(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function boolToInt(value: unknown): number {
  return value === true ? 1 : 0;
}

function clampInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomId(): string {
  return crypto.randomUUID();
}

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToBase64Url(data);
}

function previewToken(token: string): string {
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = bytesToBase64Url(saltBytes);
  const hash = await pbkdf2(password, salt);
  return { salt, hash };
}

async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  const actual = await pbkdf2(password, salt);
  return timingSafeEqual(actual, expected);
}

async function pbkdf2(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

function sessionCookie(token: string, expiresAt: number): Headers {
  return new Headers({
    "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(expiresAt * 1000).toUTCString()}`,
  });
}

function clearSessionCookie(): Headers {
  return new Headers({
    "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  });
}

async function getCurrentUser(env: Env, request: Request): Promise<UserDto | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const now = nowSeconds();
  const row = await env.DB.prepare(
    `
      SELECT u.id, u.username
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2
      LIMIT 1
    `,
  )
    .bind(await sha256Hex(token), now)
    .first<UserDto>();
  if (!row) return null;
  await env.DB.prepare(`UPDATE sessions SET last_seen_at = ?2 WHERE token_hash = ?1`)
    .bind(await sha256Hex(token), now)
    .run();
  return row;
}

async function requireAdmin(
  env: Env,
  request: Request,
): Promise<{ ok: true; user: UserDto } | { ok: false; response: Response }> {
  const user = await getCurrentUser(env, request);
  if (!user) return { ok: false, response: error("UNAUTHORIZED", "请先登录", 401) };
  return { ok: true, user };
}

async function getAgentRow(env: Env, id: string): Promise<AgentRow | null> {
  return env.DB.prepare(
    `
      SELECT
        a.id, a.name, a.enabled, a.hidden, a.weight, a.group_name, a.tags,
        a.remark, a.public_remark, a.token_preview, a.created_at, a.updated_at,
        s.last_seen, s.payload_json
      FROM agents a
      LEFT JOIN agent_status s ON s.agent_id = a.id
      WHERE a.id = ?1
      LIMIT 1
    `,
  )
    .bind(id)
    .first<AgentRow>();
}

async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const config = await readNotificationConfig(env);
  if (!config.enabled) return;

  const now = nowSeconds();
  const rows = await env.DB.prepare(
    `
      SELECT a.id, a.name, s.last_seen
      FROM agents a
      LEFT JOIN agent_status s ON s.agent_id = a.id
      WHERE a.enabled = 1 AND a.hidden = 0
      ORDER BY a.weight ASC, a.created_at ASC
    `,
  ).all<{ id: string; name: string; last_seen: number | null }>();

  const state = await readNotificationState(env);
  const nextOffline: Record<string, number> = {};
  const messages: string[] = [];

  for (const row of rows.results ?? []) {
    const lastSeen = Number(row.last_seen ?? 0);
    const isOffline = lastSeen === 0 || now - lastSeen > ONLINE_WINDOW_SECONDS;

    if (isOffline) {
      nextOffline[row.id] = state.offline[row.id] ?? now;
      if (!state.offline[row.id]) {
        messages.push(`节点离线：${row.name} (${row.id})`);
      }
      continue;
    }

    if (state.offline[row.id]) {
      messages.push(`节点恢复：${row.name} (${row.id})`);
    }
  }

  if (messages.length > 0) {
    await sendNotifications(config, `Daoyi-Monitor\n${messages.join("\n")}`);
  }

  await writeSetting(env, "notification_state", JSON.stringify({ offline: nextOffline }));
}

async function readNotificationConfig(env: Env): Promise<NotificationConfig> {
  const raw = await readSetting(env, "notification_config");
  return normalizeNotificationConfig(raw ? safeJsonParse(raw) : null);
}

function normalizeNotificationConfig(raw: unknown, existing?: NotificationConfig): NotificationConfig {
  const value = isRecord(raw) ? raw : {};
  return {
    enabled: value.enabled === true,
    webhook_enabled: value.webhook_enabled === true,
    webhook_url: preserveSecret(value.webhook_url, existing?.webhook_url, 2048),
    telegram_enabled: value.telegram_enabled === true,
    telegram_bot_token: preserveSecret(value.telegram_bot_token, existing?.telegram_bot_token, 256),
    telegram_chat_id: preserveSecret(value.telegram_chat_id, existing?.telegram_chat_id, 128),
  };
}

function maskNotificationConfig(config: NotificationConfig): NotificationConfig {
  return {
    ...config,
    webhook_url: config.webhook_url ? SECRET_MASK : null,
    telegram_bot_token: config.telegram_bot_token ? SECRET_MASK : null,
    telegram_chat_id: config.telegram_chat_id ? SECRET_MASK : null,
  };
}

function preserveSecret(value: unknown, existing: string | null | undefined, max: number): string | null {
  if (value === SECRET_MASK) return existing ?? null;
  return nullableStringLoose(value, max);
}

async function readNotificationState(env: Env): Promise<NotificationState> {
  const raw = await readSetting(env, "notification_state");
  const parsed = raw ? safeJsonParse(raw) : null;

  if (!isRecord(parsed) || !isRecord(parsed.offline)) {
    return { offline: {} };
  }

  const offline: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed.offline)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      offline[key] = value;
    }
  }
  return { offline };
}

async function readSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?1 LIMIT 1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function writeSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
  )
    .bind(key, value, nowSeconds())
    .run();
}

async function sendNotifications(config: NotificationConfig, message: string): Promise<void> {
  const jobs: Promise<Response>[] = [];

  if (config.webhook_enabled && config.webhook_url) {
    jobs.push(checkNotificationResponse(
      fetch(config.webhook_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message, content: message }),
        signal: AbortSignal.timeout(5000),
      }),
      "webhook",
    ));
  }

  if (config.telegram_enabled && config.telegram_bot_token && config.telegram_chat_id) {
    const url = `https://api.telegram.org/bot${encodeURIComponent(config.telegram_bot_token)}/sendMessage`;
    jobs.push(checkNotificationResponse(
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegram_chat_id,
          text: message,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      }),
      "telegram",
    ));
  }

  if (jobs.length === 0) {
    throw new Error("No notification channel configured.");
  }

  await Promise.all(jobs);
}

async function checkNotificationResponse(request: Promise<Response>, channel: string): Promise<Response> {
  const response = await request;
  if (!response.ok) {
    throw new Error(`${channel} notification failed: ${response.status}`);
  }
  return response;
}

function agentFromRow(row: AgentRow): AgentDto {
  let metrics: Record<string, unknown> | undefined;
  if (row.payload_json) {
    try {
      metrics = extractMetrics(JSON.parse(row.payload_json));
    } catch {
      metrics = undefined;
    }
  }
  const lastSeen = row.last_seen ?? 0;
  return {
    id: row.id,
    agent_id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    hidden: Boolean(row.hidden),
    weight: Number(row.weight),
    group_name: row.group_name,
    tags: row.tags,
    remark: row.remark,
    public_remark: row.public_remark,
    token_preview: row.token_preview,
    online: lastSeen > 0 && nowSeconds() - lastSeen <= ONLINE_WINDOW_SECONDS,
    last_seen: lastSeen,
    metrics,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function publicAgentFromRow(row: AgentRow): AgentDto {
  return {
    ...agentFromRow(row),
    hidden: false,
    remark: null,
    token_preview: "",
  };
}

function extractMetrics(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const nested = payload.metrics;
  return isRecord(nested) ? nested : payload;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export { Hub };
export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
