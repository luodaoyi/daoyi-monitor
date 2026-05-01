# Daoyi-Monitor 开发方案与计划

本文是 Daoyi-Monitor 的总设计文档。目标是参考 Komari 的服务器监控体验，但重写为 Cloudflare 免费额度友好的架构，并用 Zig 实现轻量 agent。

## 1. 目标

### 1.1 产品目标

- 单租户服务器监控。
- 50 台服务器以内，默认不超过 Cloudflare 免费额度。
- 一个按钮部署到 Cloudflare。
- 后台、API、实时通道在一个 Worker 应用中完成。
- Agent 使用 Zig，静态 musl 编译，体积小，内存低，部署简单。
- Agent 支持自我更新，发布源用 GitHub Releases，国内可配置镜像。

### 1.2 非目标

- 不做多租户。
- 不做远程终端。
- 不做远程 shell。
- 不做远程任务下发。
- 不做 R2 发布 agent。
- 第一阶段不做 Windows agent。

## 2. 上游参考

参考项目：

- Komari 服务端：https://github.com/komari-monitor/komari
- Komari Agent：https://github.com/komari-monitor/komari-agent

保留的能力：

- 节点列表。
- 节点实时状态。
- CPU、内存、Swap、Load、磁盘、网络、连接数、进程数、运行时间。
- 节点基础信息：系统、内核、架构、CPU、内存、磁盘、IP、地区、agent 版本。
- 历史图表。
- 节点备注、标签、隐藏、排序。
- 管理员登录。
- 公共看板开关。
- Agent 自动注册。
- Agent 自更新。
- 离线判断。

删除的能力：

- Web terminal。
- Remote exec。
- Ping task。
- Clipboard。
- Theme marketplace。
- Nezha 兼容。
- OAuth 第一阶段不做。
- 通知第一阶段实现 Webhook 与 Telegram。

## 3. 最终架构

```text
GitHub Deploy Button
        |
        v
Cloudflare Worker App
  |-- Static Assets: 后台 SPA
  |-- Worker API: /api/*
  |-- WebSocket: /ws/agent, /ws/admin
  |-- Durable Object: Hub
  `-- D1: 用户、节点、配置、历史

Zig Agent --WebSocket--> /ws/agent --> Hub
Admin UI  --WebSocket--> /ws/admin --> Hub
Admin UI  --HTTP API----> /api/* ----> D1 / Hub
```

不使用 Pages。使用 Workers Static Assets 托管前端。这样可满足 Deploy to Cloudflare 按钮一键部署。

### 3.1 当前落地范围

当前仓库已实现的最小可运行面：

- Worker + Static Assets：`src/index.ts` 统一承载 API、静态前端、Cron。
- Durable Object：`src/durable-objects/hub.ts` 承载 `/ws/agent` 与 `/ws/admin`，用 Hibernation API。
- D1：`migrations/0001_init.sql` 建用户、会话、节点、最新状态、30 天环形历史、设置表。
- 前端：`web/src/App.svelte` 实现初始化、登录、概览、节点管理、通知配置。
- Agent：`agent/src/main.zig` 常驻采集，`agent/src/net/websocket.zig` 支持 `ws://` 与 `wss://`。
- 发布：`.github/workflows/agent-ci.yml` 与 `agent-release.yml` 自动测试、交叉编译、生成 manifest。
- 安装：`install.sh` 从 GitHub Release manifest 下载、校验、安装并创建 systemd 服务。

## 4. 免费额度计算

Cloudflare 免费额度按 2026-05-01 官方文档：

- Worker requests: 100,000/day。
- Static Assets: 免费且不限量。
- WebSocket 到 Worker：只算初始 Upgrade 请求；消息不算 Worker request。
- Durable Objects requests: 100,000/day。
- Durable Objects duration: 13,000 GB-s/day。必须用 WebSocket Hibernation API，避免长连接让 DO 常驻计时。
- DO 入站 WebSocket 消息：20 条消息折算 1 个 DO request。
- D1 rows read: 5,000,000/day。
- D1 rows written: 100,000/day。
- D1 storage: 5GB。

### 4.1 默认配置

- 最大推荐节点数：50。
- 默认实时上报间隔：3 秒。
- 默认历史存储间隔：180 秒。
- 默认历史保留：30 天。
- 默认历史清理：不使用 `DELETE`。`agent_history(agent_id, bucket_slot)` 按 30 天窗口做环形覆盖。

### 4.2 50 台、3 秒上报

```text
agent messages/day = 50 * 86400 / 3 = 1,440,000
DO requests/day    = 1,440,000 / 20 = 72,000
```

余量：

```text
100,000 - 72,000 = 28,000 DO requests/day
```

D1 历史写入：

```text
history rows/day = 50 * 86400 / 180 = 24,000
```

若 `history_3m(agent_id, bucket_ts)` 建索引，写入约翻倍：

```text
24,000 * 2 = 48,000 rows written/day
```

仍在 100,000/day 内。

### 4.3 历史保留与环形覆盖

D1 中 `DELETE` 也算 `rows written`，没有可靠的“不计用量批量删除”。因此当前实现不删除旧历史，改用固定槽位覆盖。

30 天保留时历史行数：

```text
50 * 480 * 30 = 720,000 rows
```

粗估存储：

```text
720,000 * 1KB ≈ 720MB
```

远低于 D1 免费 5GB。第 31 天后，新样本写入相同 `bucket_slot`，自然覆盖 30 天前的数据。这样没有删除成本，也不会无限增长。

水位保护：

- `< 70%`：正常。
- `70%-85%`：提示。
- `85%-95%`：警告，建议调大实时上报间隔、调大历史间隔或降低删除预算。
- `> 95%`：危险，暂停非必要清理或暂停历史写入，由用户确认。

### 4.4 DO duration 保护

DO duration 是本方案的隐形风险。设计硬规则：

- 必须使用 `ctx.acceptWebSocket()`，禁止使用普通 `ws.accept()`。
- 禁止在 DO 内使用永久 `setInterval`。
- 禁止在 WebSocket 消息处理里做长时间外部 fetch。
- D1 写入只在跨历史桶时发生，不在每个 report 上发生。
- 使用 `ctx.setWebSocketAutoResponse()` 处理 ping/pong。
- DO constructor 必须轻，不得全量读 D1。
- 单例 Hub 默认仅支持 50 台以内；日后若放宽上限，改为分片 Hub。

验收：

- 3 秒上报、50 台模拟压测下，DO request 与 duration 均低于免费额度 80% 预警线。
- 若 duration 过高，第一优先级是减少 DO 活跃时间，而不是调低 D1 写入。

### 4.5 间隔提示算法

函数：

```ts
function estimateUsage(nodeCount: number, realtimeIntervalSec: number, historyIntervalSec: number): UsageEstimate
```

公式：

```text
agent_messages_per_day = nodeCount * 86400 / realtimeIntervalSec
do_requests_per_day = ceil(agent_messages_per_day / 20)
history_rows_per_day = nodeCount * 86400 / historyIntervalSec
d1_rows_written_per_day = history_rows_per_day * (1 + history_index_count)
```

默认 `history_index_count = 1`。

状态：

- `safe`: DO 和 D1 均小于免费额度 80%。
- `warning`: 任一项在 80%-100%。
- `danger`: 任一项超过 100%。

前端在用户修改节点数、实时上报间隔、历史间隔时立即显示：

- 预计 DO requests/day。
- 预计 D1 rows written/day。
- 免费额度占比。
- 推荐最小间隔。

推荐最小实时上报间隔：

```ts
function minSafeRealtimeInterval(nodeCount: number, targetDoRequests = 80000): number {
  return Math.ceil((nodeCount * 86400) / (targetDoRequests * 20));
}
```

50 台时：

```text
1s => 216,000 DO requests/day，超额
2s => 108,000 DO requests/day，超额
3s => 72,000 DO requests/day，安全
5s => 43,200 DO requests/day，安全
```

## 5. 技术选型

### 5.1 Worker 后端

- 语言：TypeScript。
- Runtime：Cloudflare Workers。
- Router：Hono。
- Auth：Web Crypto API，PBKDF2 或 bcryptjs。优先 PBKDF2，免 native 依赖。
- DB：D1 SQL。
- Real-time：Durable Object WebSocket Hibernation API。
- Validation：zod 或自写轻量校验。第一版用自写校验，减少包体。

理由：

- TypeScript 是 Workers 一等语言。
- Hono 小，适合 Workers。
- Durable Object class 与 WebSocket API 用 TypeScript 写最直。

### 5.2 前端

- 语言：TypeScript。
- 框架：Svelte + Vite。
- 图表：uPlot。
- 样式：CSS variables + 少量组件，不引入重 UI 库。
- 构建产物：`dist/` 交给 Workers Static Assets。

理由：

- Svelte 产物小。
- uPlot 对时间序列轻且快。
- 后台是工具，不做营销页。

### 5.3 Agent

- 语言：Zig。
- Linux target：`*-linux-musl` 静态编译。
- 优化：`ReleaseSmall`，`strip=true`。
- 网络：优先轻量自写 WebSocket client；TLS 先走 Zig std，若体积或内存不可控，再拆分为 `full` 与 `tiny` 构建档。
- JSON：固定结构手写 encoder，避免动态 map。
- 内存：默认 Linux 常驻目标 `< 2MB`；优化目标 `< 1MB`；极限 tiny 构建目标 `512KB-1MB`，以实测 RSS/PSS 为准。

## 6. 仓库结构

为避免 Deploy to Cloudflare 对 monorepo 的限制，仓库根目录就是 Worker 应用。

```text
daoyi-monitor/
  README.md
  package.json
  wrangler.toml
  migrations/
    0001_init.sql
  src/
    index.ts
    env.ts
    hub.ts
    routes/
      auth.ts
      agents.ts
      admin-ws.ts
      agent-ws.ts
      history.ts
      notifications.ts
      public.ts
      settings.ts
      update.ts
    services/
      auth.ts
      agents.ts
      history.ts
      notifications.ts
      usage.ts
      update.ts
      crypto.ts
    db/
      schema.ts
      queries.ts
    types/
      api.ts
      metrics.ts
      env.ts
    utils/
      response.ts
      time.ts
      validate.ts
  web/
    index.html
    package.json
    vite.config.ts
    src/
      main.ts
      app.ts
      api/
      stores/
      views/
      components/
  public/
    assets generated by web build
  agent/
    build.zig
    build.zig.zon
    src/
      main.zig
      config.zig
      collector/
      net/
      update/
      platform/
  docs/
    development-plan.md
```

部署脚本将 `web` 构建到 `public`。

## 7. Cloudflare 配置

`wrangler.toml` 设计：

```toml
name = "daoyi-monitor"
main = "src/index.ts"
compatibility_date = "2026-05-01"

[assets]
directory = "public"
not_found_handling = "single-page-application"

[[d1_databases]]
binding = "DB"
database_name = "daoyi-monitor"
database_id = "PLACEHOLDER"

[[durable_objects.bindings]]
name = "HUB"
class_name = "Hub"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Hub"]

[vars]
APP_NAME = "Daoyi-Monitor"
DEFAULT_REALTIME_INTERVAL_SEC = "3"
DEFAULT_HISTORY_INTERVAL_SEC = "180"
```

`package.json` 脚本：

```json
{
  "scripts": {
    "build": "npm run build:web && npm run build:worker",
    "build:web": "cd web && npm install && npm run build && cd ..",
    "build:worker": "tsc --noEmit",
    "db:migrations:apply": "wrangler d1 migrations apply DB --remote",
    "deploy": "npm run build && npm run db:migrations:apply && wrangler deploy",
    "dev": "wrangler dev"
  }
}
```

Deploy Button：

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/luodaoyi/daoyi-monitor)
```

注意：

- 仓库必须 public。
- Worker 应用必须在仓库根目录。
- D1 migration 通过 `deploy` script 自动执行。
- 首次访问若无管理员，进入初始化页面。

## 8. 数据库设计

### 8.1 `users`

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 8.2 `sessions`

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

### 8.3 `agents`

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  hidden INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 0,
  group_name TEXT,
  tags TEXT,
  remark TEXT,
  public_remark TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_agents_weight ON agents(weight);
CREATE INDEX idx_agents_token_hash ON agents(token_hash);
```

### 8.4 `agent_basic`

```sql
CREATE TABLE agent_basic (
  agent_id TEXT PRIMARY KEY,
  os TEXT,
  kernel TEXT,
  arch TEXT,
  cpu_name TEXT,
  cpu_cores INTEGER,
  virtualization TEXT,
  mem_total INTEGER,
  swap_total INTEGER,
  disk_total INTEGER,
  ipv4 TEXT,
  ipv6 TEXT,
  region TEXT,
  agent_version TEXT,
  updated_at INTEGER NOT NULL
);
```

### 8.5 `history_3m`

```sql
CREATE TABLE history_3m (
  agent_id TEXT NOT NULL,
  bucket_ts INTEGER NOT NULL,
  cpu REAL NOT NULL,
  load1 REAL NOT NULL,
  load5 REAL NOT NULL,
  load15 REAL NOT NULL,
  mem_used INTEGER NOT NULL,
  mem_total INTEGER NOT NULL,
  swap_used INTEGER NOT NULL,
  swap_total INTEGER NOT NULL,
  disk_used INTEGER NOT NULL,
  disk_total INTEGER NOT NULL,
  net_up INTEGER NOT NULL,
  net_down INTEGER NOT NULL,
  net_total_up INTEGER NOT NULL,
  net_total_down INTEGER NOT NULL,
  tcp INTEGER NOT NULL,
  udp INTEGER NOT NULL,
  process_count INTEGER NOT NULL,
  uptime INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY(agent_id, bucket_ts)
);
CREATE INDEX idx_history_3m_bucket_ts ON history_3m(bucket_ts);
```

### 8.6 `settings`

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 8.7 `audit_logs`

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
```

### 8.8 `notification_channels`

```sql
CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- webhook | telegram
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`config_json` 示例：

Webhook：

```json
{
  "url": "https://example.com/webhook",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer xxx"
  }
}
```

Telegram：

```json
{
  "bot_token": "123456:ABC",
  "chat_id": "-1001234567890",
  "api_base": "https://api.telegram.org"
}
```

### 8.9 `alert_rules`

```sql
CREATE TABLE alert_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL, -- offline | cpu | load | memory | disk
  target TEXT NOT NULL DEFAULT "all", -- all | agent
  agent_id TEXT,
  threshold REAL,
  duration_sec INTEGER NOT NULL DEFAULT 300,
  cooldown_sec INTEGER NOT NULL DEFAULT 1800,
  channel_ids TEXT NOT NULL, -- JSON array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_alert_rules_enabled ON alert_rules(enabled);
```

默认规则：

- 离线：`offline`，持续 30 秒，冷却 1800 秒。
- CPU：`cpu > 90%` 持续 300 秒，冷却 1800 秒。
- Load：`load1 > cpu_cores * 2` 持续 300 秒，冷却 1800 秒。
- 内存：`memory > 90%` 持续 300 秒，冷却 1800 秒。
- 磁盘：`disk > 90%` 持续 300 秒，冷却 3600 秒。

### 8.10 `alert_events`

```sql
CREATE TABLE alert_events (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL, -- firing | resolved
  message TEXT NOT NULL,
  value REAL,
  threshold REAL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  notified_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX idx_alert_events_agent_status ON alert_events(agent_id, status);
CREATE INDEX idx_alert_events_rule_agent ON alert_events(rule_id, agent_id);
CREATE INDEX idx_alert_events_created ON alert_events(first_seen_at);
```

## 9. Worker 后端函数级设计

### 9.1 `src/index.ts`

职责：入口、路由注册、静态资源 fallback。

函数：

```ts
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>
}
```

流程：

1. 初始化 Hono app。
2. 注入 env。
3. 注册 `/api/*`。
4. 注册 `/ws/agent` 与 `/ws/admin`，转交 Hub DO。
5. 未命中 API 时交给 static assets。

函数：

```ts
function getHubStub(env: Env): DurableObjectStub
```

返回固定 singleton Hub：

```ts
env.HUB.get(env.HUB.idFromName("global"))
```

### 9.2 `src/env.ts`

职责：定义绑定。

类型：

```ts
export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_NAME: string;
  DEFAULT_REALTIME_INTERVAL_SEC: string;
  DEFAULT_HISTORY_INTERVAL_SEC: string;
}
```

### 9.3 `src/hub.ts`

职责：实时中心。单例 Durable Object。

核心状态：

```ts
type AgentSocketMeta = {
  kind: "agent";
  agentId: string;
  connectedAt: number;
};

type AdminSocketMeta = {
  kind: "admin";
  sessionId: string;
  connectedAt: number;
};

type LatestState = {
  agentId: string;
  online: boolean;
  lastSeen: number;
  metrics: MetricsReport;
};

type BucketState = {
  agentId: string;
  bucketTs: number;
  sampleCount: number;
  sum: MetricSums;
  last: MetricsReport;
};
```

类：

```ts
export class Hub extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env)
  fetch(request: Request): Promise<Response>
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>
  webSocketError(ws: WebSocket, error: unknown): Promise<void>
}
```

函数：

```ts
private async handleAgentConnect(request: Request): Promise<Response>
```

职责：

1. 校验 `Upgrade: websocket`。
2. 解析 `Authorization: Bearer <token>`。
3. 在 D1 中查 `agents.token_hash`。
4. 校验 enabled。
5. 创建 WebSocketPair。
6. `ctx.acceptWebSocket(server, tags)`。
7. `server.serializeAttachment(meta)`。
8. 返回 101。

函数：

```ts
private async handleAdminConnect(request: Request): Promise<Response>
```

职责：

1. 校验 session cookie。
2. 创建 WebSocketPair。
3. 接入 DO。
4. 发送当前 latest 快照。

函数：

```ts
private async handleAgentMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void>
```

职责：

1. 反序列化 socket attachment。
2. 解析 `AgentMessage`。
3. 若 `type=hello`，更新基础信息。
4. 若 `type=report`，调用 `ingestReport`。
5. 出错时发送 `{type:"error"}`，严重错误关闭连接。

函数：

```ts
private async ingestReport(agentId: string, report: MetricsReport): Promise<void>
```

职责：

1. 校验数值范围。
2. 更新内存 `latest`.
3. 更新桶聚合。
4. 若跨 180 秒桶，调用 `flushBucket`.
5. 调用 `evaluateMetricAlerts`.
6. 广播 latest 给 admin。

函数：

```ts
private updateBucket(agentId: string, report: MetricsReport): BucketFlush | null
```

职责：

- 当前 bucket 内做 sum。
- 跨桶时返回旧桶待 flush。
- 新桶以当前 report 初始化。

函数：

```ts
private async flushBucket(bucket: BucketState): Promise<void>
```

职责：

1. 计算平均 CPU、load、内存等。
2. 网络总量字段取最后一包。
3. `INSERT OR REPLACE INTO history_3m`。

函数：

```ts
private broadcastToAdmins(message: AdminEvent): void
```

职责：

- 遍历 `ctx.getWebSockets()`。
- 只给 attachment.kind 为 `admin` 的连接发送。
- 发送失败则关闭。

函数：

```ts
private markOffline(ws: WebSocket): void
```

职责：

- Agent socket 关闭后标记离线。
- 调用 `evaluateOfflineAlert`。
- 广播离线事件。
- 不写 D1。

函数：

```ts
private async evaluateMetricAlerts(agentId: string, report: MetricsReport): Promise<void>
```

职责：

1. 读取启用的指标告警规则。
2. 检查 CPU、load、内存、磁盘阈值。
3. 若达到 duration，创建或更新 `alert_events`。
4. 若超过 cooldown，调用通知服务发送。
5. 若指标恢复，写 resolved 事件并通知恢复。

函数：

```ts
private async evaluateOfflineAlert(agentId: string): Promise<void>
```

职责：

1. 检查 offline 规则。
2. 按 duration 与 cooldown 控制通知。
3. 写入 `alert_events`。

注意：

- 必须用 `ctx.acceptWebSocket()`，不用 `ws.accept()`。
- 自动 ping/pong 用 `ctx.setWebSocketAutoResponse()`，减少 duration。
- DO 内存可丢，下一包恢复 latest。
- 历史桶若因 DO 重启丢一小段，可接受；这是免费优先的取舍。

### 9.4 `routes/agent-ws.ts`

函数：

```ts
export async function agentWsRoute(c: Context): Promise<Response>
```

职责：

- 把 `/ws/agent` 请求转发给 Hub。

### 9.5 `routes/admin-ws.ts`

函数：

```ts
export async function adminWsRoute(c: Context): Promise<Response>
```

职责：

- 把 `/ws/admin` 请求转发给 Hub。

### 9.6 `routes/auth.ts`

函数：

```ts
export async function initStatus(c: Context): Promise<Response>
```

返回是否需要初始化管理员。

函数：

```ts
export async function initAdmin(c: Context): Promise<Response>
```

仅当 `users` 为空可调用。创建第一位管理员。

函数：

```ts
export async function login(c: Context): Promise<Response>
```

校验用户名密码，创建 session cookie。

函数：

```ts
export async function logout(c: Context): Promise<Response>
```

删除 session。

函数：

```ts
export async function me(c: Context): Promise<Response>
```

返回当前用户。

### 9.7 `services/auth.ts`

函数：

```ts
export async function hashPassword(password: string, salt?: string): Promise<PasswordHash>
```

使用 Web Crypto PBKDF2-SHA256。

函数：

```ts
export async function verifyPassword(password: string, stored: PasswordRecord): Promise<boolean>
```

常量时间比较。

函数：

```ts
export async function createSession(db: D1Database, userId: string, req: Request): Promise<Session>
```

创建随机 token，保存 hash，返回明文 token 给 cookie。

函数：

```ts
export async function requireAdmin(c: Context, next: Next): Promise<Response | void>
```

Hono middleware。

### 9.8 `routes/agents.ts`

函数：

```ts
export async function listAgents(c: Context): Promise<Response>
```

返回 D1 节点配置 + Hub latest。

函数：

```ts
export async function createAgent(c: Context): Promise<Response>
```

创建 agent，生成 token。token 只返回一次。

函数：

```ts
export async function updateAgent(c: Context): Promise<Response>
```

更新 name、group、tags、remark、public_remark、hidden、weight、enabled。

函数：

```ts
export async function getAgent(c: Context): Promise<Response>
```

返回单节点配置、基础信息、latest 状态和最近历史摘要。

函数：

```ts
export async function deleteAgent(c: Context): Promise<Response>
```

删除 agent 与历史。危险操作，需二次确认字段。

函数：

```ts
export async function rotateAgentToken(c: Context): Promise<Response>
```

重置 token，只返回一次。

### 9.9 `services/agents.ts`

函数：

```ts
export async function findAgentByToken(db: D1Database, token: string): Promise<Agent | null>
```

职责：hash token 后查 D1。

函数：

```ts
export async function createAgentToken(): Promise<{ token: string; tokenHash: string }>
```

职责：生成 32 字节随机 token。

函数：

```ts
export async function upsertAgentBasic(db: D1Database, agentId: string, basic: AgentBasic): Promise<void>
```

职责：保存 agent 基础信息。

### 9.10 `routes/history.ts`

函数：

```ts
export async function getHistory(c: Context): Promise<Response>
```

查询参数：

- `agent_id`
- `from`
- `to`
- `step`

返回历史序列。默认 `step=180`。

函数：

```ts
export async function clearHistory(c: Context): Promise<Response>
```

清空单节点或全局历史。

### 9.11 `services/history.ts`

函数：

```ts
export async function queryHistory(db: D1Database, req: HistoryQuery): Promise<HistoryPoint[]>
```

职责：按索引查询，禁止无边界全表扫。

函数：

```ts
export async function insertHistoryBucket(db: D1Database, bucket: AggregatedBucket): Promise<void>
```

职责：写入 3 分钟历史。

函数：

```ts
export async function cleanupExpiredHistory(db: D1Database, req: CleanupHistoryRequest): Promise<CleanupHistoryResult>
```

职责：

1. 计算过期时间 `cutoff = now - retention_days * 86400`。
2. 读取今日已清理行数。
3. 若达到 `cleanup_daily_budget_rows`，直接返回。
4. 以 `LIMIT cleanup_batch_size` 删除旧历史。
5. 记录清理计数到 `settings` 或 `audit_logs`。

SQL：

```sql
DELETE FROM history_3m
WHERE bucket_ts < ?1
LIMIT ?2;
```

注意：

- 删除行数也计 D1 rows written。
- 不做一次性大删除。
- 若 D1 当日写入估算超过 90%，本轮跳过清理。

### 9.12 `routes/settings.ts`

函数：

```ts
export async function getSettings(c: Context): Promise<Response>
```

返回所有设置。

函数：

```ts
export async function updateSettings(c: Context): Promise<Response>
```

更新配置，并调用 `estimateUsage` 做额度校验。

### 9.13 `services/usage.ts`

函数：

```ts
export function estimateUsage(input: UsageInput): UsageEstimate
```

职责：计算 DO、D1、Worker 估算。

函数：

```ts
export function classifyUsage(estimate: UsageEstimate): UsageLevel
```

返回 `safe | warning | danger`。

函数：

```ts
export function recommendRealtimeInterval(nodeCount: number): number
```

返回免费安全建议值。

函数：

```ts
export function validateUsageSettings(input: UsageInput): UsageValidation
```

若超过免费额度，返回错误或警告。默认禁止保存 `danger`，除非用户开启 `allow_over_free_quota`。

函数：

```ts
export function estimateCleanupUsage(input: CleanupUsageInput): CleanupUsageEstimate
```

职责：

1. 按保留天数、节点数、历史间隔估算过期行。
2. 按 `cleanup_batch_size`、`cleanup_interval_sec`、`cleanup_daily_budget_rows` 估算每日删除行。
3. 把删除写入计入 D1 rows written。
4. 返回水位等级和建议。

函数：

```ts
export function recommendCleanupBudget(input: UsageInput): CleanupBudget
```

职责：给出免费额度内的清理预算。默认优先保守，避免超过 90% D1 写入。

### 9.14 `routes/notifications.ts`

函数：

```ts
export async function listNotificationChannels(c: Context): Promise<Response>
```

返回 Webhook、Telegram 通道列表。敏感字段脱敏。

函数：

```ts
export async function createNotificationChannel(c: Context): Promise<Response>
```

创建通知通道。

函数：

```ts
export async function updateNotificationChannel(c: Context): Promise<Response>
```

更新通知通道。

函数：

```ts
export async function deleteNotificationChannel(c: Context): Promise<Response>
```

删除通知通道。

函数：

```ts
export async function testNotificationChannel(c: Context): Promise<Response>
```

发送测试通知。

函数：

```ts
export async function listAlertRules(c: Context): Promise<Response>
```

返回告警规则。

函数：

```ts
export async function updateAlertRule(c: Context): Promise<Response>
```

创建或更新告警规则。

函数：

```ts
export async function listAlertEvents(c: Context): Promise<Response>
```

返回最近告警事件。

### 9.15 `services/notifications.ts`

类型：

```ts
export type NotificationMessage = {
  title: string;
  body: string;
  level: "info" | "warning" | "critical" | "resolved";
  agentName?: string;
  agentId?: string;
  ruleName?: string;
  value?: number;
  threshold?: number;
  time: number;
};
```

函数：

```ts
export async function sendNotification(db: D1Database, channelIds: string[], message: NotificationMessage): Promise<void>
```

职责：

1. 读取启用通道。
2. 按类型分派到 Webhook 或 Telegram。
3. 单个通道失败不影响其它通道。
4. 失败写 audit log，不抛出到上报主流程。

函数：

```ts
export async function sendWebhook(channel: NotificationChannel, message: NotificationMessage): Promise<void>
```

Webhook payload：

```json
{
  "title": "Daoyi-Monitor 告警",
  "body": "server-a CPU 使用率 95%",
  "level": "critical",
  "agent_id": "...",
  "agent_name": "server-a",
  "rule_name": "CPU high",
  "value": 95,
  "threshold": 90,
  "time": 1777650000
}
```

函数：

```ts
export async function sendTelegram(channel: NotificationChannel, message: NotificationMessage): Promise<void>
```

调用：

```text
POST {api_base}/bot{bot_token}/sendMessage
```

参数：

```json
{
  "chat_id": "...",
  "text": "...",
  "parse_mode": "HTML",
  "disable_web_page_preview": true
}
```

函数：

```ts
export function renderNotificationText(message: NotificationMessage, format: "plain" | "telegram-html"): string
```

职责：统一生成通知文本，Telegram HTML 需转义。

函数：

```ts
export async function evaluateAlertRules(input: AlertEvaluationInput): Promise<AlertAction[]>
```

职责：从指标和规则计算 firing/resolved 动作。

函数：

```ts
export async function shouldNotify(db: D1Database, ruleId: string, agentId: string, cooldownSec: number, now: number): Promise<boolean>
```

职责：检查冷却时间。

### 9.16 `routes/update.ts`

函数：

```ts
export async function checkAgentUpdate(c: Context): Promise<Response>
```

Agent 调用：

```text
GET /api/agent/update?version=v0.1.0&channel=stable&target=x86_64-linux-musl&profile=full&os=linux&arch=x86_64&abi=musl
```

规则：

- `version` 统一带 `v` 前缀；服务端比较时可兼容无 `v` 输入，但输出一律带 `v`。
- `target` 是首选匹配字段。
- `os/arch/abi/profile` 是 fallback 匹配字段。
- `profile` 默认 `full`。

返回：

```json
{
  "update": true,
  "version": "0.2.0",
  "url": "https://github.com/.../download/...",
  "sha256": "...",
  "size": 1234567
}
```

函数：

```ts
export async function getReleaseManifest(c: Context): Promise<Response>
```

后台查看 release manifest。

### 9.17 `services/update.ts`

函数：

```ts
export async function fetchGithubManifest(settings: Settings): Promise<ReleaseManifest>
```

从 GitHub Releases 拉取 manifest。可配置镜像 base URL。

函数：

```ts
export function selectArtifact(manifest: ReleaseManifest, req: UpdateCheckRequest): Artifact | null
```

按 target、profile、channel 选择包；target 缺失时按 os、arch、abi、profile fallback。

函数：

```ts
export function compareSemver(a: string, b: string): number
```

轻量 semver 比较。

### 9.18 `utils/response.ts`

函数：

```ts
export function ok<T>(data: T): Response
export function error(status: number, code: string, message: string): Response
```

统一 API 响应。

响应格式：

```ts
type ApiOk<T> = { ok: true; data: T };
type ApiError = { ok: false; error: { code: string; message: string } };
type ApiResponse<T> = ApiOk<T> | ApiError;
```

错误码：

```text
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
VALIDATION_ERROR
CONFLICT
RATE_LIMITED
INTERNAL_ERROR
```

### 9.19 `utils/validate.ts`

函数：

```ts
export function parseJson<T>(request: Request, validator: Validator<T>): Promise<T>
export function assertNumberRange(name: string, value: number, min: number, max: number): void
export function assertStringLength(name: string, value: string, max: number): void
```

## 10. API 设计

### 10.0 通用约定

- 所有管理 API 使用 HttpOnly session cookie 鉴权。
- Agent WebSocket 与 update API 使用 agent token。
- JSON 响应统一为 `ApiResponse<T>`。
- 列表接口默认支持 `page`、`page_size`，最大 `page_size=100`。
- 时间戳统一 Unix seconds。
- 版本号输出统一 `vMAJOR.MINOR.PATCH`。

### 10.1 初始化与登录

```text
GET  /api/init/status
POST /api/init/admin
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

### 10.2 节点

```text
GET    /api/agents
POST   /api/agents
GET    /api/agents/:id
PATCH  /api/agents/:id
DELETE /api/agents/:id
POST   /api/agents/:id/token/rotate
```

### 10.3 历史

```text
GET    /api/history?agent_id=&from=&to=&step=
DELETE /api/history?agent_id=
```

### 10.4 设置与额度

```text
GET  /api/settings
PUT  /api/settings
POST /api/usage/estimate
```

### 10.5 通知与告警

```text
GET    /api/notifications/channels
POST   /api/notifications/channels
PATCH  /api/notifications/channels/:id
DELETE /api/notifications/channels/:id
POST   /api/notifications/channels/:id/test

GET    /api/alerts/rules
POST   /api/alerts/rules
PATCH  /api/alerts/rules/:id
DELETE /api/alerts/rules/:id
GET    /api/alerts/events
```

规则删除 handler：

```ts
export async function deleteAlertRule(c: Context): Promise<Response>
```

删除规则不删除历史事件，只把后续评估停掉。

### 10.6 Agent

```text
GET /api/agent/update
GET /ws/agent
```

### 10.7 后台实时

```text
GET /ws/admin
```

## 11. WebSocket 协议

### 11.1 Agent 连接

请求：

```text
GET /ws/agent
Authorization: Bearer <agent_token>
Upgrade: websocket
```

### 11.2 Agent hello

```json
{
  "type": "hello",
  "version": "0.1.0",
  "hostname": "server-a",
  "os": "linux",
  "kernel": "6.8.0",
  "arch": "x86_64",
  "cpu_name": "AMD EPYC",
  "cpu_cores": 2,
  "mem_total": 2147483648,
  "swap_total": 0,
  "disk_total": 42949672960,
  "ipv4": "1.2.3.4",
  "ipv6": "",
  "virtualization": "kvm"
}
```

### 11.3 Agent report

```json
{
  "type": "report",
  "ts": 1777650000,
  "cpu": 12.3,
  "load1": 0.14,
  "load5": 0.18,
  "load15": 0.21,
  "mem_used": 123456789,
  "mem_total": 2147483648,
  "swap_used": 0,
  "swap_total": 0,
  "disk_used": 1234567890,
  "disk_total": 42949672960,
  "net_up": 1234,
  "net_down": 5678,
  "net_total_up": 123456789,
  "net_total_down": 987654321,
  "tcp": 32,
  "udp": 8,
  "process_count": 91,
  "uptime": 123456
}
```

### 11.4 Server ack

```json
{
  "type": "ack",
  "server_time": 1777650001,
  "realtime_interval_sec": 3,
  "update_check_interval_sec": 21600
}
```

### 11.5 Admin 事件

```json
{
  "type": "latest",
  "data": {
    "agent_id": "...",
    "online": true,
    "last_seen": 1777650000,
    "metrics": {}
  }
}
```

```json
{
  "type": "snapshot",
  "agents": []
}
```

```json
{
  "type": "offline",
  "agent_id": "..."
}
```

## 12. 前端功能设计

### 12.1 路由

```text
/init              首次初始化
/login             登录
/                  总览
/agents            节点列表
/agents/:id        节点详情
/settings          设置
/notifications     通知与告警
/usage             免费额度估算
/audit             审计日志
/public            公共看板预览
```

### 12.2 页面函数级设计

#### `web/src/main.ts`

函数：

```ts
function bootstrap(): void
```

职责：挂载 Svelte app。

#### `web/src/api/client.ts`

函数：

```ts
export async function apiGet<T>(path: string): Promise<T>
export async function apiPost<T>(path: string, body: unknown): Promise<T>
export async function apiPatch<T>(path: string, body: unknown): Promise<T>
export async function apiDelete<T>(path: string): Promise<T>
```

职责：统一 fetch、错误处理、JSON 解析。

#### `web/src/api/ws.ts`

函数：

```ts
export function connectAdminWs(onEvent: (event: AdminEvent) => void): WebSocketController
```

职责：

- 连接 `/ws/admin`。
- 断线指数退避重连。
- 页面隐藏时保持连接，用户退出时关闭。

#### `web/src/stores/session.ts`

函数：

```ts
export async function loadMe(): Promise<void>
export async function login(username: string, password: string): Promise<void>
export async function logout(): Promise<void>
```

#### `web/src/stores/agents.ts`

函数：

```ts
export async function loadAgents(): Promise<void>
export function applyRealtimeEvent(event: AdminEvent): void
export function getAgentStatus(agentId: string): AgentStatus
```

职责：合并 D1 节点配置与 DO 实时数据。

#### `web/src/stores/settings.ts`

函数：

```ts
export async function loadSettings(): Promise<void>
export async function saveSettings(input: SettingsInput): Promise<void>
export async function estimateUsage(input: UsageInput): Promise<UsageEstimate>
```

#### `web/src/views/Dashboard.svelte`

组件职责：

- 顶部概览：在线数、离线数、CPU 平均、内存平均、今日流量。
- 节点表格：名称、在线、CPU、内存、磁盘、网络速率、运行时间。
- 实时刷新来自 WebSocket。

#### `web/src/views/AgentDetail.svelte`

组件职责：

- 实时指标。
- 历史图表。
- 基础信息。
- token 轮换入口。
- 编辑名称、标签、备注。

函数：

```ts
async function loadHistory(range: TimeRange): Promise<void>
function onRealtime(event: AdminEvent): void
function formatBytes(value: number): string
function formatUptime(seconds: number): string
```

#### `web/src/views/Settings.svelte`

组件职责：

- 实时上报间隔配置。
- 历史存储间隔配置。
- 保留天数配置。
- 清理批量大小配置。
- 每日清理预算配置。
- GitHub release 源配置。
- 国内镜像 base URL 配置。
- 免费额度计算提示。
- Webhook 通知配置入口。
- Telegram 通知配置入口。
- 告警规则配置入口。

函数：

```ts
function recalcUsage(): void
async function save(): Promise<void>
```

必须显示：

- 当前节点数。
- 当前设置下 DO requests/day。
- 当前设置下 D1 rows written/day。
- 当前设置下清理 rows written/day。
- 预计历史存储大小。
- 免费额度百分比。
- 是否安全。

#### `web/src/views/Notifications.svelte`

组件职责：

- 通知通道列表。
- 新增 Webhook。
- 新增 Telegram。
- 测试发送。
- 启用/禁用通道。
- 告警规则列表。
- 编辑阈值、持续时间、冷却时间、通知通道。
- 最近告警事件。

函数：

```ts
async function loadChannels(): Promise<void>
async function saveWebhook(input: WebhookInput): Promise<void>
async function saveTelegram(input: TelegramInput): Promise<void>
async function testChannel(channelId: string): Promise<void>
async function loadAlertRules(): Promise<void>
async function saveAlertRule(input: AlertRuleInput): Promise<void>
async function loadAlertEvents(): Promise<void>
```

UI 要求：

- Telegram bot token 输入框默认隐藏，保存后只显示脱敏值。
- Webhook headers 使用 key/value 表格。
- 测试发送按钮必须显示成功或错误响应。
- 告警规则默认提供离线、CPU、Load、内存、磁盘五类模板。

### 12.3 UI 原则

- 工具型后台，不做 landing。
- 信息密度高，颜色克制。
- 图表清晰，默认 1h、6h、24h、7d。
- 移动端可看，不强求全功能编辑。
- 所有危险操作都需确认。

## 13. Zig Agent 函数级设计

### 13.1 构建目标

第一阶段：

```text
x86_64-linux-musl
aarch64-linux-musl
arm-linux-musl
arm-linux-musleabihf
arm-linux-musleabi
armeb-linux-musleabi
armeb-linux-musleabihf
mips-linux-musl
mipsel-linux-musl
mips-linux-muslsf
mipsel-linux-muslsf
mips64-linux-musl
mips64el-linux-musl
powerpc-linux-musl
powerpc64-linux-musl
powerpc64le-linux-musl
riscv64-linux-musl
s390x-linux-musl
x86_64-freebsd
aarch64-freebsd
x86-freebsd
x86_64-macos
aarch64-macos
```

Windows 后续：

```text
x86-windows
x86_64-windows
aarch64-windows
```

构建策略：

- Linux 以 musl 静态为主。
- FreeBSD/macOS 作为可用性构建，允许动态系统 ABI。
- Windows 后置，但 CI 矩阵先预留。
- 任何 target 编译失败不得阻塞核心 Linux musl 发布；标记为 experimental。

### 13.2 `agent/src/main.zig`

函数：

```zig
pub fn main() !void
```

流程：

1. 解析参数。
2. 加载配置。
3. 若 `install` 子命令，安装 systemd service。
4. 若 `run`，进入主循环。
5. 定期采集。
6. WebSocket 发送。
7. 定期检查更新。

函数：

```zig
fn runAgent(config: Config) !void
```

职责：连接、重连、采集、上报。

### 13.3 `agent/src/config.zig`

类型：

```zig
pub const Config = struct {
    endpoint: []const u8,
    token: []const u8,
    interval_sec: u16,
    update_channel: []const u8,
    update_mirror: ?[]const u8,
    disable_update: bool,
};
```

函数：

```zig
pub fn load(allocator: Allocator) !Config
pub fn loadFromFile(allocator: Allocator, path: []const u8) !Config
pub fn loadFromArgs(allocator: Allocator) !PartialConfig
pub fn merge(defaults: Config, file: PartialConfig, args: PartialConfig) Config
```

配置路径：

```text
/etc/daoyi-agent/config.toml
~/.config/daoyi-agent/config.toml
```

### 13.4 `collector/metrics.zig`

类型：

```zig
pub const Metrics = struct {
    ts: i64,
    cpu: f64,
    load1: f64,
    load5: f64,
    load15: f64,
    mem_used: u64,
    mem_total: u64,
    swap_used: u64,
    swap_total: u64,
    disk_used: u64,
    disk_total: u64,
    net_up: u64,
    net_down: u64,
    net_total_up: u64,
    net_total_down: u64,
    tcp: u32,
    udp: u32,
    process_count: u32,
    uptime: u64,
};
```

函数：

```zig
pub fn collect(buf: *ScratchBuffer) !Metrics
```

职责：调用各平台 collector。

### 13.5 `collector/linux.zig`

函数：

```zig
pub fn readCpuStat(prev: *CpuSample, current: *CpuSample) !f64
```

读 `/proc/stat`，计算 CPU 使用率。

函数：

```zig
pub fn readMemInfo() !MemInfo
```

读 `/proc/meminfo`。

函数：

```zig
pub fn readLoadAvg() !LoadAvg
```

读 `/proc/loadavg`。

函数：

```zig
pub fn readNetDev(prev: *NetSample, current: *NetSample) !NetRate
```

读 `/proc/net/dev`，排除 `lo`。

函数：

```zig
pub fn readDiskUsage(paths: []const []const u8) !DiskUsage
```

用 `statvfs`，默认根分区 `/`。

函数：

```zig
pub fn countProcesses() !u32
```

遍历 `/proc` 数字目录。

函数：

```zig
pub fn countConnections() !ConnectionCount
```

读 `/proc/net/tcp`、`/proc/net/udp`、IPv6 对应文件。

函数：

```zig
pub fn readUptime() !u64
```

读 `/proc/uptime`。

### 13.6 `collector/basic.zig`

函数：

```zig
pub fn collectBasicInfo(buf: *ScratchBuffer) !BasicInfo
```

职责：收集 hello 信息。

Linux：

- `/etc/os-release`
- `uname`
- `/proc/cpuinfo`
- `/proc/meminfo`
- `statvfs`

### 13.7 `net/websocket.zig`

函数：

```zig
pub fn connect(allocator: Allocator, config: Config) !WsClient
```

职责：

- 生成 `wss://host/ws/agent`。
- 加 `Authorization: Bearer`。
- 完成握手。

函数：

```zig
pub fn sendText(client: *WsClient, payload: []const u8) !void
pub fn readControl(client: *WsClient) !ServerCommand
pub fn close(client: *WsClient) void
```

只支持：

- text frame。
- ping/pong。
- close。

不支持远控命令。

### 13.8 `net/json.zig`

函数：

```zig
pub fn encodeHello(buf: []u8, info: BasicInfo) ![]const u8
pub fn encodeReport(buf: []u8, metrics: Metrics) ![]const u8
```

职责：固定结构 JSON 输出。不得使用动态 map。

### 13.9 `update/update.zig`

函数：

```zig
pub fn check(config: Config, current_version: []const u8) !?UpdateInfo
```

调用 `/api/agent/update` 或 GitHub manifest。

函数：

```zig
pub fn download(allocator: Allocator, info: UpdateInfo, dest: []const u8) !void
```

下载新二进制到临时文件。

函数：

```zig
pub fn verifySha256(path: []const u8, expected: []const u8) !void
```

校验 sha256。

函数：

```zig
pub fn replaceSelf(newPath: []const u8) !void
```

Linux：

- 写到同目录 `.new`。
- chmod。
- rename 原子替换。
- exit code `42`，由 systemd restart。

### 13.10 `platform/service_linux.zig`

函数：

```zig
pub fn installService(configPath: []const u8) !void
pub fn uninstallService() !void
pub fn printInstallScript() !void
```

生成 systemd unit：

```ini
[Service]
ExecStart=/usr/local/bin/daoyi-agent run --config /etc/daoyi-agent/config.toml
Restart=always
RestartSec=5
```

### 13.11 内存与体积要求

内存目标分三档：

```text
full:   < 2MB RSS，默认 WSS + 自更新 + 完整 collector
small:  < 1MB RSS，WSS + collector，减少 update 常驻状态
tiny:   512KB-1MB RSS，最小 collector + 极小 buffer，必要时禁用自更新或改 HTTP fallback
```

要求：

- 主循环使用固定 scratch buffer。
- JSON buffer 默认 2048 字节，不够则报错，不自动无限扩容。
- WebSocket 读写 buffer 默认 2048 字节，复用。
- 禁止每轮采集堆分配。
- 启动阶段可少量分配，进入主循环后不得增长。
- collector 不使用动态 map、ArrayList 长期增长结构。
- 只保留当前和上一轮 CPU、网络 sample。
- BasicInfo 只在启动和低频刷新时采集，不每轮采。
- 自更新模块不得常驻大 buffer；下载时流式写文件。
- ReleaseSmall + strip。
- 编译期开关裁剪功能：`-Dtiny=true`、`-Ddisable-update=true`、`-Dhttp-only=false`。

验收口径：

```text
Linux RSS: /proc/<pid>/status VmRSS
Linux PSS: /proc/<pid>/smaps_rollup Pss
运行 24 小时后内存不得持续增长
```

512KB 目标说明：

- 在 musl 静态、WSS、证书校验、自更新全开时，512KB RSS 不保证可达。
- `tiny` 构建必须作为极限优化目标保留。
- 若实测 WSS 版本无法低于 1MB，允许提供 `tiny-http` 构建供反代内网或用户明确选择。

## 14. Agent 发布与更新

GitHub Release 包命名：

```text
daoyi-agent-v0.1.0-full-x86_64-linux-musl.tar.gz
daoyi-agent-v0.1.0-full-aarch64-linux-musl.tar.gz
daoyi-agent-v0.1.0-tiny-mipsel-linux-musl.tar.gz
```

Manifest：

```json
{
  "version": "0.1.0",
  "channel": "stable",
  "artifacts": [
    {
      "os": "linux",
      "arch": "x86_64",
      "abi": "musl",
      "target": "x86_64-linux-musl",
      "profile": "full",
      "libc": "musl",
      "url": "https://github.com/...tar.gz",
      "sha256": "...",
      "size": 1234567
    }
  ]
}
```

国内镜像：

- 设置 `release_base_url`。
- Worker 返回 update URL 时替换 base URL。

版本规则：

- Release tag 使用 `agent-v0.1.0`。
- Manifest `version` 使用 `v0.1.0`。
- Agent 上报可传 `0.1.0` 或 `v0.1.0`，服务端归一为 `v0.1.0`。
- 产物命名必须包含 `profile` 与 `target`。

## 15. Agent CI/CD 自动构建

Agent 使用 GitHub Actions 自动构建、打包、校验并发布。目标是尽可能覆盖更多架构，同时不让边缘架构失败阻塞主线发布。

### 15.1 Workflow 文件

```text
.github/workflows/agent-ci.yml
.github/workflows/agent-release.yml
```

`agent-ci.yml`：

- 触发：pull request、push 到 main。
- 只编译核心 target。
- 运行 Zig 单元测试。
- 上传短期 artifacts 供检查。

`agent-release.yml`：

- 触发：tag `agent-v*` 或 release dispatch。
- 编译完整 target 矩阵。
- 生成压缩包。
- 计算 sha256。
- 生成 `manifest.json`。
- 创建 GitHub Release 或上传到已有 Release。

### 15.2 Zig 版本固定

使用固定 Zig 版本，避免编译产物随 nightly 漂移。

```yaml
env:
  ZIG_VERSION: "0.14.0"
```

若将来依赖 Zig master 才能构建部分架构，则：

- 默认 release 用 stable Zig。
- experimental workflow 可用 nightly。
- manifest 中标记 `experimental: true`。

### 15.3 构建矩阵

核心 Linux musl：

```text
x86_64-linux-musl
aarch64-linux-musl
arm-linux-musleabihf
arm-linux-musleabi
mips-linux-musl
mipsel-linux-musl
riscv64-linux-musl
```

扩展 Linux musl：

```text
arm-linux-musl
armeb-linux-musleabi
armeb-linux-musleabihf
mips-linux-muslsf
mipsel-linux-muslsf
mips64-linux-musl
mips64el-linux-musl
powerpc-linux-musl
powerpc64-linux-musl
powerpc64le-linux-musl
s390x-linux-musl
```

BSD/macOS：

```text
x86-freebsd
x86_64-freebsd
aarch64-freebsd
x86_64-macos
aarch64-macos
```

Windows 后续：

```text
x86-windows
x86_64-windows
aarch64-windows
```

构建档：

```text
full
small
tiny
```

默认 release 必须产出 `full`。`small` 与 `tiny` 优先覆盖核心 Linux musl；其它平台视可用性逐步补齐。

### 15.4 产物命名

```text
daoyi-agent-{version}-{profile}-{target}.tar.gz
daoyi-agent-{version}-{profile}-{target}.zip
```

示例：

```text
daoyi-agent-v0.1.0-full-x86_64-linux-musl.tar.gz
daoyi-agent-v0.1.0-small-aarch64-linux-musl.tar.gz
daoyi-agent-v0.1.0-tiny-mipsel-linux-musl.tar.gz
daoyi-agent-v0.1.0-full-x86_64-windows.zip
```

压缩包内容：

```text
daoyi-agent
README-agent.md
LICENSE
```

Windows 包内容：

```text
daoyi-agent.exe
README-agent.md
LICENSE
```

`checksums.txt` 作为 Release 顶层文件发布，不放进每个压缩包。每个压缩包另有同名 `.sha256`。

### 15.5 build.zig 要求

`agent/build.zig` 必须支持：

```sh
zig build -Dtarget=x86_64-linux-musl -Doptimize=ReleaseSmall -Dprofile=full -Dstrip=true
zig build -Dtarget=x86_64-linux-musl -Doptimize=ReleaseSmall -Dprofile=small -Dstrip=true
zig build -Dtarget=x86_64-linux-musl -Doptimize=ReleaseSmall -Dprofile=tiny -Dstrip=true
```

编译选项：

```text
-Dprofile=full|small|tiny
-Ddisable-update=true|false
-Dhttp-only=true|false
-Dstrip=true|false
```

profile 映射：

```text
full:  WSS + 自更新 + 完整 collector
small: WSS + 自更新检查低频 + 完整 collector + 小 buffer
tiny:  WSS 或 HTTP fallback + 可禁用自更新 + 最小 buffer
```

### 15.6 Release manifest

CI 生成 `manifest.json`：

```json
{
  "version": "v0.1.0",
  "channel": "stable",
  "generated_at": 1777650000,
  "artifacts": [
    {
      "os": "linux",
      "arch": "x86_64",
      "abi": "musl",
      "target": "x86_64-linux-musl",
      "profile": "full",
      "url": "https://github.com/luodaoyi/daoyi-monitor/releases/download/agent-v0.1.0/daoyi-agent-v0.1.0-full-x86_64-linux-musl.tar.gz",
      "sha256": "...",
      "size": 1234567,
      "experimental": false
    }
  ]
}
```

规则：

- 每个 artifact 必须有 sha256。
- 核心 Linux musl `full` 缺失时 release 失败。
- 扩展 target 缺失时 release 可继续，但 manifest 标记缺失报告。
- `tiny` 若未达内存目标，也可发布，但 release note 必须写实测 RSS/PSS。

### 15.7 Workflow 函数脚本

脚本目录：

```text
scripts/
  build-agent-target.mjs
  package-agent.mjs
  generate-agent-manifest.mjs
  verify-agent-artifacts.mjs
```

函数：

```ts
async function buildAgentTarget(target: string, profile: string): Promise<BuildResult>
```

职责：调用 `zig build`，收集二进制路径、大小、错误。

函数：

```ts
async function packageAgentArtifact(input: PackageInput): Promise<PackageResult>
```

职责：按平台生成 `.tar.gz` 或 `.zip`。

函数：

```ts
async function sha256File(path: string): Promise<string>
```

职责：生成校验值。

函数：

```ts
async function generateManifest(results: PackageResult[]): Promise<ReleaseManifest>
```

职责：生成自更新使用的 manifest。

函数：

```ts
async function verifyRequiredArtifacts(manifest: ReleaseManifest): Promise<void>
```

职责：检查核心 Linux musl `full` 是否齐全。

### 15.8 CI 验收

- PR 上必须编译核心 Linux musl。
- tag release 必须生成 manifest。
- Release 中必须包含 `manifest.json` 与 `checksums.txt`。
- Worker `/api/agent/update` 能解析 manifest 并选中正确 artifact。
- 安装脚本能根据 `uname -m` 和系统类型映射到 target。
- release note 自动列出成功、失败、experimental target。

## 16. 安全设计

### 16.1 Agent token

- token 只明文显示一次。
- D1 只存 hash。
- WebSocket 使用 `Authorization: Bearer`。
- 后续可加 HMAC 时间戳，但第一版不做，免复杂。

### 16.2 Admin session

- HttpOnly cookie。
- SameSite=Lax。
- Secure 自动依赖 HTTPS。
- session 30 天过期。

### 16.3 数值校验

Worker 必须拒绝：

- CPU < 0 或 > 100。
- load < 0 或 > 10000。
- 负数内存、磁盘、网络。
- 超大 JSON。
- 非法 agent id。

### 16.4 免费额度保护

- 保存设置前调用 `validateUsageSettings`。
- 默认禁止保存会超免费额度的设置。
- 可提供隐藏高级开关，但 UI 明确提示。
- 后台首页显示今日估算占比。

### 16.5 通知安全

- Telegram bot token 不在列表接口明文返回。
- Webhook headers 中 `Authorization`、`X-Api-Key` 等字段脱敏。
- 测试通知接口要求管理员 session。
- 通知发送失败不得阻塞 agent 上报。
- Webhook 超时默认 5 秒。
- Telegram 超时默认 5 秒。
- 每条告警规则有 cooldown，避免刷屏。

## 17. 开发阶段

### 阶段 0：项目骨架

- 建 `package.json`。
- 建 `wrangler.toml`。
- 建 D1 migration。
- 建 Hono Worker。
- 建 Svelte 前端。
- 建 Deploy Button。

验收：

- `npm run dev` 可启动。
- `/` 显示初始化页。
- `/api/init/status` 可用。

### 阶段 1：后台登录与节点管理

- 初始化管理员。
- 登录、登出、session。
- 节点增删改查。
- token 生成与轮换。

验收：

- 可创建 agent。
- token 只显示一次。

### 阶段 2：Durable Object 实时链路

- `/ws/agent`。
- `/ws/admin`。
- hello/report 协议。
- latest 内存态。
- 后台实时表格。

验收：

- mock agent 每 3 秒上报。
- 后台 1 秒内看到变化。

### 阶段 3：D1 历史

- 180 秒桶聚合。
- `history_3m` 写入。
- 预算式滚动清理。
- 历史 API。
- 节点详情图表。

验收：

- 10 分钟运行后有历史图。
- D1 写入符合估算。
- 清理任务每小时最多删除配置的 batch 行。
- 删除预算达到上限后当日停止清理。

### 阶段 4：额度计算与设置

- `services/usage.ts`。
- 设置页。
- 保存配置时校验。
- Dashboard 显示安全状态。
- 设置页显示清理预算、预计存储和 D1 写入水位。

验收：

- 50 台 3 秒显示 safe。
- 50 台 1 秒显示 danger。
- 50 台、3 秒、180 秒历史、30 天保留、每小时删 800 行显示 safe。

### 阶段 5：通知与告警

- Webhook 通道。
- Telegram 通道。
- 测试发送。
- 默认告警规则。
- 告警事件表。
- DO 收包触发指标告警。
- Agent 断开触发离线告警。

验收：

- CPU 阈值触发 Webhook。
- 离线触发 Telegram。
- cooldown 生效，不刷屏。
- 恢复事件可记录并通知。

### 阶段 6：Zig Linux Agent

- 配置加载。
- Linux collector。
- WebSocket client。
- hello/report。
- systemd install。

验收：

- x86_64-linux-musl 静态二进制可运行。
- 默认构建常驻内存小于 2MB。
- small 构建常驻内存力争小于 1MB。
- tiny 构建以 512KB-1MB 为目标，记录实测 RSS/PSS。
- 默认 3 秒上报稳定 24 小时。

### 阶段 7：自更新

- GitHub manifest。
- Worker update API。
- Agent 下载、sha256 校验、替换自身。

验收：

- 发布新版本后 agent 自动更新。
- 更新失败不破坏旧二进制。

### 阶段 8：多架构构建

- `agent-ci.yml`。
- `agent-release.yml`。
- Zig 版本固定。
- 核心 Linux musl 矩阵。
- 扩展 Linux musl 矩阵。
- FreeBSD/macOS 构建。
- Windows 构建预留。
- full/small/tiny profile。
- 打包 `.tar.gz` / `.zip`。
- 生成 `checksums.txt`。
- 生成 `manifest.json`。
- Release note 列出成功、失败、experimental target。

验收：

- PR 可编译核心 Linux musl。
- tag `agent-v*` 自动创建 GitHub Release。
- Release 至少包含核心 Linux musl full 产物。
- Release 包含 `manifest.json` 与 `checksums.txt`。
- Worker update API 能从 manifest 选择正确 target。
- 安装脚本能把 `uname -m` 映射到 release target。

### 阶段 9：体验补全

- 公共看板。
- 审计日志。
- 数据清理日志与水位提示。
- 通知模板优化。
- 告警事件筛选。

## 18. 测试计划

### 18.1 Worker 单元测试

- `estimateUsage`。
- password hash/verify。
- token hash。
- report validator。
- bucket aggregation。
- semver compare。
- notification text render。
- alert rule evaluation。

### 18.2 Worker 集成测试

- 初始化管理员。
- 登录。
- 创建 agent。
- WebSocket agent mock 上报。
- history 写入。

### 18.3 前端测试

- 初始化流程。
- 登录流程。
- 设置页额度提示。
- 通知通道测试。
- 实时列表。

### 18.4 Agent 测试

- collector parser fixtures。
- JSON encoder。
- WebSocket reconnect。
- update sha256。
- systemd unit 生成。

### 18.5 Agent CI/CD 测试

- build matrix dry-run。
- artifact 命名校验。
- sha256 校验。
- manifest schema 校验。
- required target 校验。
- release target 与安装脚本架构映射校验。

## 19. 风险与取舍

### 19.1 DO 内存丢失

DO hibernation 或重启会清内存。下一次 report 恢复 latest。历史桶可能丢当前桶少量样本。

取舍：接受。若要零丢失，会增加 D1 写入，不利免费额度。

### 19.2 1 秒上报

50 台 1 秒会超 DO 免费请求。允许小规模用户配置，但 UI 必须警告。

### 19.3 D1 删除计写入

删除旧历史也算 rows written。当前实现采用环形覆盖，不做删除。30 天、50 台、3 分钟历史约 720,000 行，粗估小于 1GB，远小于 5GB。第 31 天后覆盖相同槽位，存储不再线性增长。

### 19.4 Zig TLS 体积

Zig std TLS 可能增加体积和常驻内存。默认 WSS 仍是安全优先；若实测内存过高，提供 `small` 与 `tiny` 构建档。`tiny` 可以牺牲部分便利能力，例如禁用自更新、降低 buffer、减少 collector 项，或提供 `tiny-http` 供用户在可信反代后使用。

## 20. 第一版默认参数

```text
max_recommended_agents = 50
realtime_interval_sec = 3
history_interval_sec = 180
offline_after_sec = 15
history_retention_days = 30
cleanup_batch_size = 800
cleanup_interval_sec = 3600
cleanup_daily_budget_rows = 19200
update_check_interval_sec = 21600
```

离线判断：

```text
online = now - last_seen <= max(offline_after_sec, realtime_interval_sec * 5)
```

## 21. README 必备内容

- 项目说明。
- Deploy to Cloudflare 按钮。
- 首次初始化说明。
- 创建 agent 说明。
- Linux 一键安装 agent。
- 免费额度说明。
- 自更新说明。
- 多架构支持表。
- MIT License。

## 22. Linux Agent 安装命令草案

```sh
curl -fsSL https://raw.githubusercontent.com/luodaoyi/daoyi-monitor/main/install.sh | sh -s -- \
  --endpoint https://your-worker.workers.dev \
  --token YOUR_AGENT_TOKEN
```

安装脚本职责：

1. 识别 OS/ARCH。
2. 下载 GitHub Release。
3. 校验 sha256。
4. 写 `/usr/local/bin/daoyi-agent`。
5. 写 `/etc/daoyi-agent/config.toml`。
6. 安装 systemd unit。
7. 启动服务。

## 23. 实施顺序建议

先做能跑闭环：

1. Worker + D1 init。
2. Admin 登录。
3. Agent 创建。
4. DO WebSocket mock 上报。
5. 前端实时表格。
6. D1 3 分钟历史。
7. Zig Linux agent。
8. 自更新。

不要先写漂亮 UI，也不要先做多平台 agent。先让一台 Linux 节点稳定跑 24 小时。
