<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { ApiRequestError } from "./api/client";
  import { connectAdminWs, type WebSocketController } from "./api/ws";
  import {
    agents,
    agentsLoading,
    applyRealtimeEvent,
    clearAgents,
    createAgent,
    deleteAgent as removeAgent,
    loadAgents,
    rotateAgentToken
  } from "./stores/agents";
  import { initAdmin, initStatus, loadInitStatus } from "./stores/init";
  import {
    loadNotificationSettings,
    notificationSettings,
    notificationSettingsLoading,
    saveNotificationSettings,
    testNotificationSettings
  } from "./stores/settings";
  import { clearSession, currentUser, loadMe, login, logout, sessionLoading } from "./stores/session";
  import type { AgentCreateInput, AgentRecord, NotificationConfig } from "./types";

  type Route = "/" | "/agents" | "/settings" | "/init" | "/login";
  type Notice = { kind: "error" | "success"; message: string };
  type RevealedSecret = { title: string; name: string; token: string };

  let route: Route = "/";
  let appLoading = true;
  let bootError = "";
  let notice: Notice | null = null;
  let ws: WebSocketController | undefined;

  let initUsername = "";
  let initPassword = "";
  let initPasswordConfirm = "";
  let initSubmitting = false;

  let loginUsername = "";
  let loginPassword = "";
  let loginSubmitting = false;

  let createOpen = false;
  let createSubmitting = false;
  let createName = "";
  let createGroup = "";
  let createTags = "";
  let createRemark = "";
  let createPublicRemark = "";
  let createWeight = 0;
  let createEnabled = true;
  let createHidden = false;

  let deleteTarget: AgentRecord | null = null;
  let deleteConfirm = "";
  let deleteSubmitting = false;
  let rotateTargetId = "";
  let copyingSecret = false;
  let revealedSecret: RevealedSecret | null = null;
  let notificationSaving = false;
  let notificationTesting = false;
  let notificationForm: NotificationConfig = defaultNotificationConfig();

  $: onlineCount = $agents.filter((item) => item.online).length;
  $: visibleAgents = $agents.filter((item) => !item.hidden);
  $: hiddenCount = $agents.length - visibleAgents.length;
  $: cpuAverage = averageMetricAny(visibleAgents, ["cpu", "cpu_percent"]);
  $: memoryAverage = averageRatioAny(visibleAgents, ["mem_used", "memory_used"], ["mem_total", "memory_total"]);
  $: lastReportAt = latestLastSeen($agents);
  $: previewAgents = $agents.slice(0, 6);

  onMount(() => {
    syncRouteFromLocation();
    const handlePopState = () => {
      syncRouteFromLocation();
      void enforceRouteRules();
    };

    window.addEventListener("popstate", handlePopState);
    void bootstrap();

    return () => {
      window.removeEventListener("popstate", handlePopState);
      closeRealtime();
    };
  });

  async function bootstrap(): Promise<void> {
    appLoading = true;
    bootError = "";
    notice = null;

    try {
      const status = await loadInitStatus();

      if (!status.initialized) {
        clearAgents();
        closeRealtime();
        if (route !== "/init") {
          navigate("/init", true);
        }
        return;
      }

      if (route === "/init") {
        navigate("/login", true);
      }

      await loadMe();

      if (!get(currentUser)) {
        clearAgents();
        closeRealtime();
        if (route !== "/login") {
          navigate("/login", true);
        }
        return;
      }

      await activateAuthenticatedArea();
    } catch (error) {
      bootError = toErrorMessage(error);
    } finally {
      appLoading = false;
    }
  }

  async function enforceRouteRules(): Promise<void> {
    const status = get(initStatus);
    const user = get(currentUser);

    if (status && !status.initialized && route !== "/init") {
      navigate("/init", true);
      return;
    }

    if (status?.initialized && !user && route !== "/login") {
      navigate("/login", true);
      return;
    }

    if (user && (route === "/login" || route === "/init")) {
      navigate("/", true);
    }
  }

  async function activateAuthenticatedArea(): Promise<void> {
    try {
      await loadAgents();
      await loadNotificationSettings();
      syncNotificationForm();
    } catch (error) {
      if (await handleUnauthorized(error)) {
        return;
      }

      notice = { kind: "error", message: `节点列表加载失败：${toErrorMessage(error)}` };
    }

    connectRealtime();

    if (route === "/login" || route === "/init") {
      navigate("/", true);
    }
  }

  async function submitInit(): Promise<void> {
    notice = null;

    const username = initUsername.trim();
    if (!username) {
      notice = { kind: "error", message: "管理员用户名不可为空。" };
      return;
    }

    if (!$initStatus?.schemaReady) {
      notice = { kind: "error", message: "数据库尚未迁移，先执行 D1 migration。" };
      return;
    }

    if (initPassword.length < 8) {
      notice = { kind: "error", message: "初始化密码至少 8 位。" };
      return;
    }

    if (initPassword !== initPasswordConfirm) {
      notice = { kind: "error", message: "两次密码不合。" };
      return;
    }

    initSubmitting = true;

    try {
      await initAdmin(username, initPassword);
      await loadMe();

      if (!get(currentUser)) {
        await login(username, initPassword);
      }

      initPassword = "";
      initPasswordConfirm = "";
      notice = { kind: "success", message: "管理员已立，可继续入内。" };
      await activateAuthenticatedArea();
    } catch (error) {
      notice = { kind: "error", message: `初始化失败：${toErrorMessage(error)}` };
    } finally {
      initSubmitting = false;
    }
  }

  async function submitLogin(): Promise<void> {
    notice = null;

    const username = loginUsername.trim();
    if (!username || !loginPassword) {
      notice = { kind: "error", message: "用户名与密码皆不可空。" };
      return;
    }

    loginSubmitting = true;

    try {
      await login(username, loginPassword);
      loginPassword = "";
      notice = { kind: "success", message: "登录已成。" };
      await activateAuthenticatedArea();
    } catch (error) {
      notice = { kind: "error", message: `登录失败：${toErrorMessage(error)}` };
    } finally {
      loginSubmitting = false;
    }
  }

  async function submitLogout(): Promise<void> {
    notice = null;

    try {
      await logout();
      clearAgents();
      closeRealtime();
      revealedSecret = null;
      navigate("/login", true);
      notice = { kind: "success", message: "会话已退。" };
    } catch (error) {
      notice = { kind: "error", message: `退出失败：${toErrorMessage(error)}` };
    }
  }

  async function refreshAgents(): Promise<void> {
    notice = null;

    try {
      await loadAgents();
      notice = { kind: "success", message: "节点列表已刷新。" };
    } catch (error) {
      if (await handleUnauthorized(error)) {
        return;
      }

      notice = { kind: "error", message: `刷新失败：${toErrorMessage(error)}` };
    }
  }

  async function submitCreateAgent(): Promise<void> {
    notice = null;

    let input: AgentCreateInput;
    try {
      input = buildCreateAgentInput();
    } catch (error) {
      notice = { kind: "error", message: toErrorMessage(error) };
      return;
    }

    createSubmitting = true;

    try {
      const result = await createAgent(input);
      createOpen = false;
      resetCreateForm();
      revealSecret("新节点 token", result.agent.name, result.token);
      notice = { kind: "success", message: `节点 ${result.agent.name} 已创建。` };
      navigate("/agents");
    } catch (error) {
      if (await handleUnauthorized(error)) {
        return;
      }

      notice = { kind: "error", message: `创建节点失败：${toErrorMessage(error)}` };
    } finally {
      createSubmitting = false;
    }
  }

  async function confirmDeleteAgent(): Promise<void> {
    if (!deleteTarget) return;

    if (deleteConfirm.trim() !== deleteTarget.agent_id) {
      notice = { kind: "error", message: "请键入完整节点 ID 以确认删除。" };
      return;
    }

    deleteSubmitting = true;

    try {
      await removeAgent(deleteTarget.id, deleteConfirm.trim());
      notice = { kind: "success", message: `节点 ${deleteTarget.name} 已删除。` };
      deleteTarget = null;
      deleteConfirm = "";
    } catch (error) {
      if (await handleUnauthorized(error)) {
        return;
      }

      notice = { kind: "error", message: `删除节点失败：${toErrorMessage(error)}` };
    } finally {
      deleteSubmitting = false;
    }
  }

  async function rotateToken(agent: AgentRecord): Promise<void> {
    notice = null;
    rotateTargetId = agent.id;

    try {
      const result = await rotateAgentToken(agent.id);
      revealSecret("轮换后的 token", result.agent.name, result.token);
      notice = { kind: "success", message: `节点 ${result.agent.name} 的 token 已轮换。` };
    } catch (error) {
      if (await handleUnauthorized(error)) {
        return;
      }

      notice = { kind: "error", message: `轮换 token 失败：${toErrorMessage(error)}` };
    } finally {
      rotateTargetId = "";
    }
  }

  async function submitNotificationSettings(): Promise<void> {
    notice = null;
    notificationSaving = true;

    try {
      const saved = await saveNotificationSettings({
        ...notificationForm,
        webhook_url: emptyToNull(notificationForm.webhook_url ?? ""),
        telegram_bot_token: emptyToNull(notificationForm.telegram_bot_token ?? ""),
        telegram_chat_id: emptyToNull(notificationForm.telegram_chat_id ?? "")
      });
      notificationForm = { ...saved };
      notice = { kind: "success", message: "通知设置已保存。" };
    } catch (error) {
      if (await handleUnauthorized(error)) return;
      notice = { kind: "error", message: `保存通知失败：${toErrorMessage(error)}` };
    } finally {
      notificationSaving = false;
    }
  }

  async function sendTestNotification(): Promise<void> {
    notice = null;
    notificationTesting = true;

    try {
      await testNotificationSettings();
      notice = { kind: "success", message: "测试通知已发出。" };
    } catch (error) {
      if (await handleUnauthorized(error)) return;
      notice = { kind: "error", message: `测试通知失败：${toErrorMessage(error)}` };
    } finally {
      notificationTesting = false;
    }
  }

  async function copySecret(): Promise<void> {
    if (!revealedSecret?.token) return;

    copyingSecret = true;

    try {
      await navigator.clipboard.writeText(revealedSecret.token);
      notice = { kind: "success", message: "token 已复制到剪贴板。" };
    } catch {
      notice = { kind: "error", message: "复制未成，请手动抄录此 token。" };
    } finally {
      copyingSecret = false;
    }
  }

  function revealSecret(title: string, name: string, token: string): void {
    revealedSecret = { title, name, token };
  }

  function buildCreateAgentInput(): AgentCreateInput {
    const name = createName.trim();
    if (!name) {
      throw new Error("节点名称不可为空。");
    }

    if (!Number.isInteger(createWeight)) {
      throw new Error("权重须为整数。");
    }

    return {
      name,
      enabled: createEnabled,
      hidden: createHidden,
      weight: createWeight,
      group_name: emptyToNull(createGroup),
      tags: emptyToNull(createTags),
      remark: emptyToNull(createRemark),
      public_remark: emptyToNull(createPublicRemark)
    };
  }

  function resetCreateForm(): void {
    createName = "";
    createGroup = "";
    createTags = "";
    createRemark = "";
    createPublicRemark = "";
    createWeight = 0;
    createEnabled = true;
    createHidden = false;
  }

  function navigate(next: Route, replace = false): void {
    route = next;
    if (replace) {
      history.replaceState({}, "", next);
      return;
    }
    history.pushState({}, "", next);
  }

  function syncRouteFromLocation(): void {
    route = normalizeRoute(window.location.pathname);
  }

  function normalizeRoute(pathname: string): Route {
    if (pathname === "/init") return "/init";
    if (pathname === "/login") return "/login";
    if (pathname === "/agents" || pathname.startsWith("/agents/")) return "/agents";
    if (pathname === "/settings") return "/settings";
    return "/";
  }

  function syncNotificationForm(): void {
    notificationForm = { ...(get(notificationSettings) ?? defaultNotificationConfig()) };
  }

  function defaultNotificationConfig(): NotificationConfig {
    return {
      enabled: false,
      webhook_enabled: false,
      webhook_url: null,
      telegram_enabled: false,
      telegram_bot_token: null,
      telegram_chat_id: null
    };
  }

  function connectRealtime(): void {
    if (ws) return;
    ws = connectAdminWs(applyRealtimeEvent);
  }

  function closeRealtime(): void {
    ws?.close();
    ws = undefined;
  }

  async function handleUnauthorized(error: unknown): Promise<boolean> {
    if (!(error instanceof ApiRequestError) || error.status !== 401) {
      return false;
    }

    clearSession();
    clearAgents();
    closeRealtime();
    navigate("/login", true);
    notice = { kind: "error", message: "会话已失，请重新登录。" };
    return true;
  }

  function averageMetric(items: AgentRecord[], key: string): number | null {
    return averageMetricAny(items, [key]);
  }

  function averageMetricAny(items: AgentRecord[], keys: string[]): number | null {
    const values = items
      .map((item) => readMetricAny(item, keys))
      .filter((value): value is number => value !== null);

    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function averageRatio(items: AgentRecord[], usedKey: string, totalKey: string): number | null {
    return averageRatioAny(items, [usedKey], [totalKey]);
  }

  function averageRatioAny(items: AgentRecord[], usedKeys: string[], totalKeys: string[]): number | null {
    const values = items
      .map((item) => {
        const used = readMetricAny(item, usedKeys);
        const total = readMetricAny(item, totalKeys);
        if (used === null || total === null || total <= 0) {
          return null;
        }
        return (used / total) * 100;
      })
      .filter((value): value is number => value !== null);

    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function latestLastSeen(items: AgentRecord[]): number | null {
    const values = items
      .map((item) => item.last_seen)
      .filter((value): value is number => value !== null);

    if (values.length === 0) return null;
    return Math.max(...values);
  }

  function readMetric(agent: AgentRecord, key: string): number | null {
    return readMetricAny(agent, [key]);
  }

  function readMetricAny(agent: AgentRecord, keys: string[]): number | null {
    for (const key of keys) {
      const value = agent.metrics?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  }

  function formatPercent(value: number | null): string {
    if (value === null) return "--";
    return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
  }

  function formatBytes(value: number | null): string {
    if (value === null || value <= 0) return "--";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let next = value;
    let index = 0;

    while (next >= 1024 && index < units.length - 1) {
      next /= 1024;
      index += 1;
    }

    return `${next.toFixed(next >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function formatLastSeen(value: number | null): string {
    if (!value) return "未上报";
    return new Date(toMillis(value)).toLocaleString("zh-CN");
  }

  function formatRelativeAge(value: number | null): string {
    if (!value) return "等待首报";

    const diff = Math.max(0, Date.now() - toMillis(value));
    const seconds = Math.floor(diff / 1000);

    if (seconds < 60) return `${seconds} 秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86400)} 天前`;
  }

  function formatTokenPreview(preview: string): string {
    return preview || "仅创建或轮换时可见";
  }

  function emptyToNull(value: string): string | null {
    const text = value.trim();
    return text ? text : null;
  }

  function toMillis(value: number): number {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }

  function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
</script>

{#if appLoading}
  <main class="gate-shell">
    <section class="gate-card compact">
      <span class="eyebrow">Daoyi-Monitor</span>
      <h1>正在探路</h1>
      <p>先查初始化，再问会话，然后才开节点面板。</p>
    </section>
  </main>
{:else if bootError}
  <main class="gate-shell">
    <section class="gate-card compact">
      <span class="eyebrow">启动受阻</span>
      <h1>前端未能接上后端</h1>
      <p>{bootError}</p>
      <button class="primary" on:click={() => void bootstrap()}>重试</button>
    </section>
  </main>
{:else if route === "/init"}
  <main class="gate-shell">
    <section class="gate-card">
      <span class="eyebrow">首次初始化</span>
      <h1>先立管理员，再开监控台</h1>
      <p>
        {#if $initStatus?.schemaReady}
          当前尚无管理员。填下第一位账户，后端便可转入登录流程。
        {:else}
          `app_meta` 尚未就绪。先跑 D1 migration，再来初始化。
        {/if}
      </p>

      {#if notice}
        <div class={`notice ${notice.kind}`}>{notice.message}</div>
      {/if}

      <form class="stack-form" on:submit|preventDefault={() => void submitInit()}>
        <label>
          管理员用户名
          <input bind:value={initUsername} autocomplete="username" placeholder="root" />
        </label>
        <label>
          管理员密码
          <input
            bind:value={initPassword}
            type="password"
            autocomplete="new-password"
            placeholder="至少 8 位"
          />
        </label>
        <label>
          再输一遍密码
          <input
            bind:value={initPasswordConfirm}
            type="password"
            autocomplete="new-password"
            placeholder="再次确认"
          />
        </label>
        <div class="action-row">
          <button class="primary" disabled={initSubmitting || !$initStatus?.schemaReady}>
            {initSubmitting ? "初始化中..." : "创建管理员"}
          </button>
          <button class="ghost" type="button" on:click={() => void bootstrap()}>重查状态</button>
        </div>
      </form>

      <div class="status-inline">
        <span>schema: {$initStatus?.schemaReady ? "ready" : "missing"}</span>
        <span>initialized: {$initStatus?.initialized ? "yes" : "no"}</span>
      </div>
    </section>
  </main>
{:else if route === "/login"}
  <main class="gate-shell">
    <section class="gate-card">
      <span class="eyebrow">管理员登录</span>
      <h1>会话进门，节点方可说话</h1>
      <p>初始化既成之后，管理 API 与 `/ws/admin` 皆凭此 session cookie 通行。</p>

      {#if notice}
        <div class={`notice ${notice.kind}`}>{notice.message}</div>
      {/if}

      <form class="stack-form" on:submit|preventDefault={() => void submitLogin()}>
        <label>
          用户名
          <input bind:value={loginUsername} autocomplete="username" placeholder="root" />
        </label>
        <label>
          密码
          <input bind:value={loginPassword} type="password" autocomplete="current-password" />
        </label>
        <div class="action-row">
          <button class="primary" disabled={loginSubmitting || $sessionLoading}>
            {loginSubmitting ? "登录中..." : "登录"}
          </button>
          <button class="ghost" type="button" on:click={() => void bootstrap()}>重查初始化</button>
        </div>
      </form>

      <div class="status-inline">
        <span>初始化时间：{$initStatus?.initializedAt ? new Date($initStatus.initializedAt).toLocaleString("zh-CN") : "未初始化"}</span>
      </div>
    </section>
  </main>
{:else}
  <main class="shell">
    <aside class="sidebar">
      <div class="brand-block">
        <span class="eyebrow">Daoyi-Monitor</span>
        <div class="brand">管理前台</div>
        <p>初始化、登录、节点管理，先把第一版骨架立住。</p>
      </div>

      <nav class="nav">
        <button class:active={route === "/"} on:click={() => navigate("/")}>总览</button>
        <button class:active={route === "/agents"} on:click={() => navigate("/agents")}>节点</button>
        <button class:active={route === "/settings"} on:click={() => navigate("/settings")}>通知</button>
      </nav>

      <section class="session-card">
        <div class="session-head">
          <span>当前会话</span>
          <strong>{$currentUser?.username ?? "未登录"}</strong>
        </div>
        <div class="session-meta">
          <span>初始化：{$initStatus?.initializedAt ? new Date($initStatus.initializedAt).toLocaleString("zh-CN") : "未记"}</span>
          <span>最近上报：{formatLastSeen(lastReportAt)}</span>
        </div>
        <button class="ghost block" disabled={$sessionLoading} on:click={() => void submitLogout()}>
          {$sessionLoading ? "处理中..." : "退出会话"}
        </button>
      </section>
    </aside>

    <section class="content">
      {#if notice}
        <div class={`notice ${notice.kind}`}>{notice.message}</div>
      {/if}

      {#if revealedSecret}
        <section class="secret-card">
          <div>
            <span class="eyebrow">{revealedSecret.title}</span>
            <h2>{revealedSecret.name}</h2>
            <p>此 token 只明文露面这一回，务必当场收好。</p>
          </div>
          <code>{revealedSecret.token || "后端未回明文 token，请核对接口返回。"} </code>
          <div class="action-row">
            <button class="primary" disabled={copyingSecret || !revealedSecret.token} on:click={() => void copySecret()}>
              {copyingSecret ? "复制中..." : "复制 token"}
            </button>
            <button class="ghost" on:click={() => (revealedSecret = null)}>收起</button>
          </div>
        </section>
      {/if}

      {#if route === "/"}
        <header class="hero">
          <div>
            <span class="eyebrow">概览</span>
            <h1>会话已开，实时链路亦已接上</h1>
            <p>此页先看初始化是否成、会话是否稳、节点是否在线。细项则移步“节点”。</p>
          </div>
          <div class="action-row">
            <button class="primary" on:click={() => navigate("/agents")}>管理节点</button>
            <button class="ghost" disabled={$agentsLoading} on:click={() => void refreshAgents()}>
              {$agentsLoading ? "刷新中..." : "刷新列表"}
            </button>
          </div>
        </header>

        <section class="stats-grid">
          <article class="stat-card">
            <span>在线节点</span>
            <strong>{onlineCount}</strong>
            <small>共 {$agents.length} 台</small>
          </article>
          <article class="stat-card">
            <span>隐藏节点</span>
            <strong>{hiddenCount}</strong>
            <small>列表仍可管理</small>
          </article>
          <article class="stat-card">
            <span>平均 CPU</span>
            <strong>{formatPercent(cpuAverage)}</strong>
            <small>仅按已上报节点计</small>
          </article>
          <article class="stat-card">
            <span>平均内存占用</span>
            <strong>{formatPercent(memoryAverage)}</strong>
            <small>取内存 used / total</small>
          </article>
        </section>

        <section class="panel">
          <div class="section-head">
            <div>
              <span class="eyebrow">节点速览</span>
              <h2>先看前六台</h2>
            </div>
            <button class="ghost" on:click={() => navigate("/agents")}>去全量列表</button>
          </div>

          <div class="agent-list">
            {#if previewAgents.length === 0}
              <div class="empty-card">
                <h3>尚无节点</h3>
                <p>可先去“节点”页创建第一台 agent，并收下只显示一次的 token。</p>
              </div>
            {:else}
              {#each previewAgents as agent}
                <article class="agent-card">
                  <div class="agent-card-head">
                    <div>
                      <h3>{agent.name}</h3>
                      <span>{agent.agent_id}</span>
                    </div>
                    <span class:online={agent.online} class="status-chip">
                      {agent.online ? "在线" : "离线"}
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>CPU</dt>
                      <dd>{formatPercent(readMetricAny(agent, ["cpu", "cpu_percent"]))}</dd>
                    </div>
                    <div>
                      <dt>内存</dt>
                      <dd>{formatBytes(readMetricAny(agent, ["mem_used", "memory_used"]))}</dd>
                    </div>
                    <div>
                      <dt>最后上报</dt>
                      <dd>{formatRelativeAge(agent.last_seen)}</dd>
                    </div>
                  </dl>
                </article>
              {/each}
            {/if}
          </div>
        </section>
      {:else if route === "/agents"}
        <header class="hero slim">
          <div>
            <span class="eyebrow">节点管理</span>
            <h1>创建、列出、删除、轮换 token</h1>
            <p>列表取 `/api/agents`，危险动作需会话在手。删除前，须键入节点 ID 以再确认。</p>
          </div>
          <div class="action-row">
            <button class="primary" on:click={() => (createOpen = !createOpen)}>
              {createOpen ? "收起表单" : "新建节点"}
            </button>
            <button class="ghost" disabled={$agentsLoading} on:click={() => void refreshAgents()}>
              {$agentsLoading ? "刷新中..." : "刷新"}
            </button>
          </div>
        </header>

        {#if createOpen}
          <section class="panel form-panel">
            <div class="section-head">
              <div>
                <span class="eyebrow">创建节点</span>
                <h2>保存配置，并领走一次性 token</h2>
              </div>
            </div>

            <form class="grid-form" on:submit|preventDefault={() => void submitCreateAgent()}>
              <label>
                节点名称
                <input bind:value={createName} placeholder="tokyo-edge-01" />
              </label>
              <label>
                分组
                <input bind:value={createGroup} placeholder="apac" />
              </label>
              <label>
                标签
                <input bind:value={createTags} placeholder="prod,edge,linux" />
              </label>
              <label>
                权重
                <input bind:value={createWeight} type="number" step="1" />
              </label>
              <label class="full">
                内部备注
                <textarea bind:value={createRemark} rows="3" placeholder="仅管理员可见"></textarea>
              </label>
              <label class="full">
                公共备注
                <textarea
                  bind:value={createPublicRemark}
                  rows="3"
                  placeholder="展示给公共面板的短说明"
                ></textarea>
              </label>
              <label class="toggle">
                <input bind:checked={createEnabled} type="checkbox" />
                <span>启用此节点</span>
              </label>
              <label class="toggle">
                <input bind:checked={createHidden} type="checkbox" />
                <span>默认隐藏</span>
              </label>
              <div class="action-row full">
                <button class="primary" disabled={createSubmitting}>
                  {createSubmitting ? "创建中..." : "创建并生成 token"}
                </button>
                <button class="ghost" type="button" on:click={resetCreateForm}>清空</button>
              </div>
            </form>
          </section>
        {/if}

        <section class="panel table-panel">
          <div class="section-head">
            <div>
              <span class="eyebrow">节点列表</span>
              <h2>{$agents.length} 台节点</h2>
            </div>
            <div class="table-meta">
              <span>{onlineCount} 在线</span>
              <span>{hiddenCount} 隐藏</span>
            </div>
          </div>

          {#if $agents.length === 0}
            <div class="empty-card">
              <h3>列表是空的</h3>
              <p>若后端已就绪，先点“新建节点”。若接口未通，则本页会在上方报错。</p>
            </div>
          {:else}
            <div class="table-wrap">
              <table class="agent-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>分组 / 标签</th>
                    <th>状态</th>
                    <th>资源</th>
                    <th>Token 预览</th>
                    <th>最后上报</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {#each $agents as agent}
                    <tr>
                      <td>
                        <div class="cell-title">
                          <strong>{agent.name}</strong>
                          <span>{agent.agent_id}</span>
                          <div class="badges">
                            {#if !agent.enabled}
                              <span class="mini-badge">disabled</span>
                            {/if}
                            {#if agent.hidden}
                              <span class="mini-badge">hidden</span>
                            {/if}
                          </div>
                        </div>
                      </td>
                      <td>
                        <div class="cell-lines">
                          <span>{agent.group_name ?? "未分组"}</span>
                          <small>{agent.tags ?? "无标签"}</small>
                        </div>
                      </td>
                      <td>
                        <span class:online={agent.online} class="status-chip">
                          {agent.online ? "在线" : "离线"}
                        </span>
                      </td>
                      <td>
                        <div class="cell-lines">
                          <span>CPU {formatPercent(readMetricAny(agent, ["cpu", "cpu_percent"]))}</span>
                          <small>Mem {formatBytes(readMetricAny(agent, ["mem_used", "memory_used"]))}</small>
                        </div>
                      </td>
                      <td>
                        <code class="token-preview">{formatTokenPreview(agent.token_preview)}</code>
                      </td>
                      <td>
                        <div class="cell-lines">
                          <span>{formatLastSeen(agent.last_seen)}</span>
                          <small>{formatRelativeAge(agent.last_seen)}</small>
                        </div>
                      </td>
                      <td>
                        <div class="cell-actions">
                          <button
                            class="ghost small"
                            disabled={rotateTargetId === agent.id}
                            on:click={() => void rotateToken(agent)}
                          >
                            {rotateTargetId === agent.id ? "轮换中..." : "轮换 token"}
                          </button>
                          <button class="danger small" on:click={() => ((deleteTarget = agent), (deleteConfirm = ""))}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>
      {:else}
        <header class="hero slim">
          <div>
            <span class="eyebrow">通知</span>
            <h1>Webhook 与 Telegram</h1>
            <p>定时任务每 5 分钟巡检离线与恢复，消息只在状态变化时发送。</p>
          </div>
          <div class="action-row">
            <button class="ghost" disabled={$notificationSettingsLoading} on:click={() => void loadNotificationSettings().then(syncNotificationForm)}>
              {$notificationSettingsLoading ? "读取中..." : "重读设置"}
            </button>
          </div>
        </header>

        <section class="panel form-panel">
          <div class="section-head">
            <div>
              <span class="eyebrow">告警通道</span>
              <h2>保存后由 Worker Cron 执行</h2>
            </div>
          </div>

          <form class="grid-form" on:submit|preventDefault={() => void submitNotificationSettings()}>
            <label class="toggle full">
              <input bind:checked={notificationForm.enabled} type="checkbox" />
              <span>启用通知</span>
            </label>
            <label class="toggle">
              <input bind:checked={notificationForm.webhook_enabled} type="checkbox" />
              <span>Webhook</span>
            </label>
            <label>
              Webhook URL
              <input bind:value={notificationForm.webhook_url} placeholder="https://example.com/webhook" />
            </label>
            <label class="toggle">
              <input bind:checked={notificationForm.telegram_enabled} type="checkbox" />
              <span>Telegram</span>
            </label>
            <label>
              Bot Token
              <input bind:value={notificationForm.telegram_bot_token} type="password" placeholder="123456:ABC..." />
            </label>
            <label>
              Chat ID
              <input bind:value={notificationForm.telegram_chat_id} placeholder="-1001234567890" />
            </label>
            <div class="action-row full">
              <button class="primary" disabled={notificationSaving}>
                {notificationSaving ? "保存中..." : "保存通知设置"}
              </button>
              <button
                class="ghost"
                type="button"
                disabled={notificationTesting || notificationSaving || !notificationForm.enabled}
                on:click={() => void sendTestNotification()}
              >
                {notificationTesting ? "发送中..." : "发送测试"}
              </button>
            </div>
          </form>
        </section>
      {/if}
    </section>
  </main>
{/if}

{#if deleteTarget}
  <button
    class="modal-backdrop"
    type="button"
    aria-label="关闭删除确认"
    disabled={deleteSubmitting}
    on:click={() => !deleteSubmitting && (deleteTarget = null)}
  ></button>
  <section class="modal">
    <span class="eyebrow danger-text">危险操作</span>
    <h2>删除 {deleteTarget.name}</h2>
    <p>
      此举将调用 `/api/agents/{deleteTarget.id}`。按文档，需二次确认字段；此处请键入
      `<code>{deleteTarget.agent_id}</code>`。
    </p>
    <label>
      节点 ID
      <input bind:value={deleteConfirm} placeholder={deleteTarget.agent_id} />
    </label>
    <div class="action-row">
      <button class="danger" disabled={deleteSubmitting} on:click={() => void confirmDeleteAgent()}>
        {deleteSubmitting ? "删除中..." : "确认删除"}
      </button>
      <button class="ghost" disabled={deleteSubmitting} on:click={() => (deleteTarget = null)}>取消</button>
    </div>
  </section>
{/if}
