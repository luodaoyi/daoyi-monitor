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
    loadPublicAgents,
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

  type Route = "/" | "/admin" | "/admin/agents" | "/admin/settings" | "/admin/init" | "/admin/login";
  type Notice = { kind: "error" | "success"; message: string };
  type RevealedSecret = { title: string; name: string; token: string };

  let route: Route = "/";
  let appLoading = true;
  let bootError = "";
  let notice: Notice | null = null;
  let ws: WebSocketController | undefined;
  let publicRefreshTimer: number | undefined;
  let clockTimer: number | undefined;
  let currentTime = new Date();
  let publicSearch = "";
  let publicViewMode: "grid" | "table" = "grid";

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
  let copyingInstallCommand = false;
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
  $: sortedVisibleAgents = [...visibleAgents].sort(compareAgentsForMonitor);
  $: previewAgents = sortedVisibleAgents.slice(0, 8);
  $: groupCount = new Set(visibleAgents.map((item) => item.group_name ?? "default")).size;
  $: publicAgents = sortedVisibleAgents.filter(matchesPublicSearch);
  $: publicOnlineCount = publicAgents.filter((item) => item.online).length;
  $: publicGroupCount = new Set(publicAgents.map(publicGroupLabel)).size;
  $: publicUploadTotal = sumMetricAny(publicAgents, ["network_total_up", "net_total_up", "total_upload", "tx_total"]);
  $: publicDownloadTotal = sumMetricAny(publicAgents, ["network_total_down", "net_total_down", "total_download", "rx_total"]);
  $: publicUploadSpeed = sumMetricAny(publicAgents, ["network_up", "net_up", "upload_bps", "tx_bps"]);
  $: publicDownloadSpeed = sumMetricAny(publicAgents, ["network_down", "net_down", "download_bps", "rx_bps"]);

  onMount(() => {
    syncRouteFromLocation();
    const handlePopState = () => {
      syncRouteFromLocation();
      void enforceRouteRules();
    };

    window.addEventListener("popstate", handlePopState);
    clockTimer = window.setInterval(() => {
      currentTime = new Date();
    }, 1000);
    void bootstrap();

    return () => {
      window.removeEventListener("popstate", handlePopState);
      closeRealtime();
      stopPublicRefresh();
      if (clockTimer !== undefined) {
        window.clearInterval(clockTimer);
      }
    };
  });

  async function bootstrap(): Promise<void> {
    appLoading = true;
    bootError = "";
    notice = null;

    try {
      const status = await loadInitStatus();

      if (!isAdminRoute(route)) {
        closeRealtime();
        await activatePublicArea();
        return;
      }

      stopPublicRefresh();

      if (!status.initialized) {
        clearAgents();
        closeRealtime();
        if (route !== "/admin/init") {
          navigate("/admin/init", true);
        }
        return;
      }

      if (route === "/admin/init") {
        navigate("/admin/login", true);
      }

      await loadMe();

      if (!get(currentUser)) {
        clearAgents();
        closeRealtime();
        if (route !== "/admin/login") {
          navigate("/admin/login", true);
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

    if (!isAdminRoute(route)) {
      closeRealtime();
      await activatePublicArea();
      return;
    }

    stopPublicRefresh();

    if (status && !status.initialized && route !== "/admin/init") {
      navigate("/admin/init", true);
      return;
    }

    if (status?.initialized && !user && route !== "/admin/login") {
      navigate("/admin/login", true);
      return;
    }

    if (user && (route === "/admin/login" || route === "/admin/init")) {
      navigate("/admin", true);
    }
  }

  async function activatePublicArea(): Promise<void> {
    if (!get(initStatus)?.schemaReady) {
      clearAgents();
      stopPublicRefresh();
      return;
    }

    try {
      await loadPublicAgents();
      startPublicRefresh();
    } catch (error) {
      notice = { kind: "error", message: `公共节点加载失败：${toErrorMessage(error)}` };
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

      notice = { kind: "error", message: `节点加载失败：${toErrorMessage(error)}` };
    }

    connectRealtime();

    if (route === "/admin/login" || route === "/admin/init") {
      navigate("/admin", true);
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
      notice = { kind: "error", message: "数据库尚未迁移，请先执行 D1 migration。" };
      return;
    }

    if (initPassword.length < 8) {
      notice = { kind: "error", message: "初始化密码至少 8 位。" };
      return;
    }

    if (initPassword !== initPasswordConfirm) {
      notice = { kind: "error", message: "两次密码不一致。" };
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
      notice = { kind: "success", message: "管理员已创建。" };
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
      notice = { kind: "error", message: "用户名与密码不可为空。" };
      return;
    }

    loginSubmitting = true;

    try {
      await login(username, loginPassword);
      loginPassword = "";
      notice = { kind: "success", message: "登录成功。" };
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
      navigate("/admin/login", true);
      notice = { kind: "success", message: "会话已退出。" };
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
      revealSecret("新节点 Token", result.agent.name, result.token);
      notice = { kind: "success", message: `节点 ${result.agent.name} 已创建。` };
      navigate("/admin/agents");
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
      revealSecret("轮换后的 Token", result.agent.name, result.token);
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
      notice = { kind: "success", message: "token 已复制。" };
    } catch {
      notice = { kind: "error", message: "复制失败，请手动保存此 token。" };
    } finally {
      copyingSecret = false;
    }
  }

  async function copyInstallCommand(): Promise<void> {
    if (!revealedSecret?.token) return;

    copyingInstallCommand = true;

    try {
      await navigator.clipboard.writeText(buildInstallCommand(revealedSecret.token));
      notice = { kind: "success", message: "安装命令已复制。" };
    } catch {
      notice = { kind: "error", message: "复制失败，请手动复制安装命令。" };
    } finally {
      copyingInstallCommand = false;
    }
  }

  function revealSecret(title: string, name: string, token: string): void {
    revealedSecret = { title, name, token };
  }

  function buildInstallCommand(token: string): string {
    const origin = window.location.origin;
    return [
      "curl -fsSL",
      `${origin}/install.sh`,
      "| sh -s --",
      "--endpoint",
      shellQuote(origin),
      "--token",
      shellQuote(token),
      "--profile full",
      "--interval 3",
      "--installer-url",
      shellQuote(`${origin}/install.sh`)
    ].join(" ");
  }

  function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
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
    const previous = route;
    route = next;
    if (replace) {
      history.replaceState({}, "", next);
    } else {
      history.pushState({}, "", next);
    }

    if (isAdminRoute(next) && !isAdminRoute(previous)) {
      void bootstrap();
      return;
    }

    if (!isAdminRoute(next) && isAdminRoute(previous)) {
      closeRealtime();
      void activatePublicArea();
    }
  }

  function syncRouteFromLocation(): void {
    route = normalizeRoute(window.location.pathname);
  }

  function normalizeRoute(pathname: string): Route {
    if (pathname === "/admin/init" || pathname === "/init") return "/admin/init";
    if (pathname === "/admin/login" || pathname === "/login") return "/admin/login";
    if (pathname === "/admin/agents" || pathname.startsWith("/admin/agents/") || pathname === "/agents") return "/admin/agents";
    if (pathname === "/admin/settings" || pathname === "/settings") return "/admin/settings";
    if (pathname === "/admin") return "/admin";
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
    navigate("/admin/login", true);
    notice = { kind: "error", message: "会话已失，请重新登录。" };
    return true;
  }

  function isAdminRoute(value: Route): boolean {
    return value.startsWith("/admin");
  }

  function startPublicRefresh(): void {
    if (publicRefreshTimer !== undefined) return;
    publicRefreshTimer = window.setInterval(() => {
      if (route === "/") {
        void loadPublicAgents();
      }
    }, 30_000);
  }

  function stopPublicRefresh(): void {
    if (publicRefreshTimer === undefined) return;
    window.clearInterval(publicRefreshTimer);
    publicRefreshTimer = undefined;
  }

  function compareAgentsForMonitor(left: AgentRecord, right: AgentRecord): number {
    if (left.online !== right.online) return Number(right.online) - Number(left.online);
    if (left.weight !== right.weight) return left.weight - right.weight;
    return left.name.localeCompare(right.name, "zh-Hans-CN");
  }

  function averageMetricAny(items: AgentRecord[], keys: string[]): number | null {
    const values = items
      .map((item) => readMetricAny(item, keys))
      .filter((value): value is number => value !== null);

    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function averageRatioAny(items: AgentRecord[], usedKeys: string[], totalKeys: string[]): number | null {
    const values = items
      .map((item) => ratioMetric(item, usedKeys, totalKeys))
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

  function readMetricAny(agent: AgentRecord, keys: string[]): number | null {
    for (const key of keys) {
      const value = agent.metrics?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  }

  function readStringMetricAny(agent: AgentRecord, keys: string[]): string | null {
    for (const key of keys) {
      const value = agent.metrics?.[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    const platform = agent.metrics?.platform;
    if (typeof platform === "object" && platform !== null) {
      const record = platform as Record<string, unknown>;
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value;
      }
    }
    return null;
  }

  function ratioMetric(agent: AgentRecord, usedKeys: string[], totalKeys: string[]): number | null {
    const used = readMetricAny(agent, usedKeys);
    const total = readMetricAny(agent, totalKeys);
    if (used === null || total === null || total <= 0) return null;
    return (used / total) * 100;
  }

  function cpuPercent(agent: AgentRecord): number | null {
    return readMetricAny(agent, ["cpu", "cpu_percent"]);
  }

  function memoryPercent(agent: AgentRecord): number | null {
    return ratioMetric(agent, ["mem_used", "memory_used"], ["mem_total", "memory_total"]);
  }

  function diskPercent(agent: AgentRecord): number | null {
    return ratioMetric(agent, ["disk_used", "disk_usage"], ["disk_total"]);
  }

  function diskWarn(agent: AgentRecord): boolean {
    const value = diskPercent(agent);
    return value !== null && value >= 70;
  }

  function uploadSpeed(agent: AgentRecord): number | null {
    return readMetricAny(agent, ["network_up", "net_up", "upload_bps", "tx_bps"]);
  }

  function downloadSpeed(agent: AgentRecord): number | null {
    return readMetricAny(agent, ["network_down", "net_down", "download_bps", "rx_bps"]);
  }

  function totalUpload(agent: AgentRecord): number | null {
    return readMetricAny(agent, ["network_total_up", "net_total_up", "total_upload", "tx_total"]);
  }

  function totalDownload(agent: AgentRecord): number | null {
    return readMetricAny(agent, ["network_total_down", "net_total_down", "total_download", "rx_total"]);
  }

  function sumMetricAny(items: AgentRecord[], keys: string[]): number | null {
    let total = 0;
    let count = 0;
    for (const item of items) {
      const value = readMetricAny(item, keys);
      if (value === null) continue;
      total += value;
      count += 1;
    }
    return count > 0 ? total : null;
  }

  function formatPercent(value: number | null): string {
    if (value === null) return "-";
    return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
  }

  function formatMetricBytes(agent: AgentRecord, keys: string[]): string {
    return formatBytes(readMetricAny(agent, keys));
  }

  function formatBytes(value: number | null): string {
    if (value === null || value <= 0) return "-";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let next = value;
    let index = 0;

    while (next >= 1024 && index < units.length - 1) {
      next /= 1024;
      index += 1;
    }

    return `${next.toFixed(next >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function formatSpeed(value: number | null): string {
    if (value === null || value <= 0) return "-";
    return `${formatBytes(value)}/s`;
  }

  function formatLastSeen(value: number | null): string {
    if (!value) return "未上报";
    return new Date(toMillis(value)).toLocaleString("zh-CN");
  }

  function formatClock(value: Date): string {
    return value.toLocaleTimeString("zh-CN", { hour12: false });
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

  function formatUptime(agent: AgentRecord): string {
    const seconds = readMetricAny(agent, ["uptime_sec", "uptime_seconds", "uptime"]);
    if (seconds === null || seconds < 0) return "-";

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days} 天 ${hours} 小时`;
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    return `${minutes} 分`;
  }

  function osName(agent: AgentRecord): string {
    const value = readStringMetricAny(agent, ["os", "os_name", "platform_os"]);
    if (!value) return "-";
    const lower = value.toLowerCase();
    if (lower.includes("debian")) return "Debian";
    if (lower.includes("ubuntu")) return "Ubuntu";
    if (lower.includes("centos")) return "CentOS";
    if (lower.includes("openwrt")) return "OpenWrt";
    if (lower.includes("freebsd")) return "FreeBSD";
    if (lower.includes("darwin") || lower.includes("mac")) return "macOS";
    if (lower.includes("linux")) return "Linux";
    return value;
  }

  function archName(agent: AgentRecord): string {
    return readStringMetricAny(agent, ["arch", "architecture", "platform_arch"]) ?? "-";
  }

  function publicGroupLabel(agent: AgentRecord): string {
    return agent.group_name ?? "default";
  }

  function flagForAgent(agent: AgentRecord): string {
    const text = `${agent.group_name ?? ""} ${agent.tags ?? ""} ${agent.public_remark ?? ""}`.toLowerCase();
    if (text.includes("cn") || text.includes("china") || text.includes("中国")) return "🇨🇳";
    if (text.includes("hk") || text.includes("香港")) return "🇭🇰";
    if (text.includes("jp") || text.includes("japan") || text.includes("日本")) return "🇯🇵";
    if (text.includes("kr") || text.includes("korea") || text.includes("韩国")) return "🇰🇷";
    if (text.includes("sg") || text.includes("singapore") || text.includes("新加坡")) return "🇸🇬";
    if (text.includes("us") || text.includes("usa") || text.includes("美国")) return "🇺🇸";
    return "🌐";
  }

  function matchesPublicSearch(agent: AgentRecord): boolean {
    const keyword = publicSearch.trim().toLowerCase();
    if (!keyword) return true;
    const haystack = [
      agent.name,
      agent.group_name,
      agent.tags,
      agent.public_remark,
      osName(agent),
      archName(agent)
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(keyword);
  }

  function formatTokenPreview(preview: string): string {
    return preview || "仅创建或轮换时可见";
  }

  function percentWidth(value: number | null): string {
    if (value === null) return "0%";
    return `${Math.max(0, Math.min(100, value))}%`;
  }

  function splitTags(value: string | null): string[] {
    if (!value) return [];
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 4);
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
  <main class="auth-shell">
    <section class="auth-card compact">
      <div class="brand-mark">D</div>
      <h1>Daoyi Monitor</h1>
      <p>正在连接控制台。</p>
    </section>
  </main>
{:else if bootError}
  <main class="auth-shell">
    <section class="auth-card compact">
      <div class="brand-mark warn">!</div>
      <h1>启动失败</h1>
      <p>{bootError}</p>
      <button class="btn primary" on:click={() => void bootstrap()}>重试</button>
    </section>
  </main>
{:else if route === "/"}
  <main class="app-shell public-shell">
    <header class="topbar public-topbar">
      <div class="brand-line">
        <div>
          <strong>Daoyi Monitor</strong>
          <span>Komari Monitor</span>
        </div>
      </div>
      <div class="top-actions">
        <button class="icon-btn" title="刷新" disabled={$agentsLoading} on:click={() => void loadPublicAgents()}>
          {$agentsLoading ? "…" : "↻"}
        </button>
        <button class="btn soft" on:click={() => navigate("/admin")}>后台管理</button>
      </div>
    </header>

    <section class="content public-content">
      {#if notice}
        <div class={`notice ${notice.kind}`}>{notice.message}</div>
      {/if}

      <section class="summary-card public-summary">
        <div class="status-grid">
          <article>
            <span>当前时间</span>
            <strong>{formatClock(currentTime)}</strong>
          </article>
          <article>
            <span>当前在线</span>
            <strong>{publicOnlineCount} / {publicAgents.length}</strong>
          </article>
          <article>
            <span>点亮分组</span>
            <strong>{publicGroupCount}</strong>
          </article>
          <article>
            <span>流量概览</span>
            <strong>↑ {formatBytes(publicUploadTotal)} / ↓ {formatBytes(publicDownloadTotal)}</strong>
          </article>
          <article>
            <span>网络速率</span>
            <strong>↑ {formatSpeed(publicUploadSpeed)} / ↓ {formatSpeed(publicDownloadSpeed)}</strong>
          </article>
        </div>
      </section>

      <section class="public-toolbar">
        <label class="search-box">
          <span class="search-icon" aria-hidden="true"></span>
          <input bind:value={publicSearch} name="public_search" placeholder="搜索节点名称、分组、系统..." />
        </label>
        <div class="display-switch">
          <span>显示模式</span>
          <button class:active={publicViewMode === "grid"} title="卡片" on:click={() => (publicViewMode = "grid")}>▦</button>
          <button class:active={publicViewMode === "table"} title="表格" on:click={() => (publicViewMode = "table")}>☷</button>
        </div>
      </section>

      <p class="public-count">共 {publicAgents.length} 个服务器，{publicOnlineCount} 个在线</p>

      {#if publicViewMode === "grid"}
        <section class="node-grid public-node-grid">
          {#if publicAgents.length === 0}
            <div class="empty-state">
              <h2>暂无公开节点</h2>
              <p>后台创建并启用节点后，前台会自动显示非隐藏节点。</p>
            </div>
          {:else}
            {#each publicAgents as agent}
              <article class="node-card public-node-card">
                <div class="node-head">
                  <div class="node-title">
                    <span class="flag-mark">{flagForAgent(agent)}</span>
                    <div>
                      <h2>{agent.name}</h2>
                    </div>
                  </div>
                  <span class:online={agent.online} class="badge">{agent.online ? "在线" : "离线"}</span>
                </div>

                <div class="public-os-row">
                  <span>OS</span>
                  <strong>{osName(agent)} / {archName(agent)}</strong>
                </div>

                <div class="usage-list public-usage">
                  <div class="usage-row">
                    <span>CPU</span>
                    <strong>{formatPercent(cpuPercent(agent))}</strong>
                    <div class="usage-bar"><i style={`width: ${percentWidth(cpuPercent(agent))}`}></i></div>
                  </div>
                  <div class="usage-row">
                    <span>内存</span>
                    <strong>{formatPercent(memoryPercent(agent))}</strong>
                    <div class="usage-bar"><i style={`width: ${percentWidth(memoryPercent(agent))}`}></i></div>
                    <small>{formatMetricBytes(agent, ["mem_used", "memory_used"])} / {formatMetricBytes(agent, ["mem_total", "memory_total"])}</small>
                  </div>
                  <div class="usage-row">
                    <span>磁盘</span>
                    <strong>{formatPercent(diskPercent(agent))}</strong>
                    <div class="usage-bar"><i class:warn={diskWarn(agent)} style={`width: ${percentWidth(diskPercent(agent))}`}></i></div>
                    <small>{formatMetricBytes(agent, ["disk_used", "disk_usage"])} / {formatMetricBytes(agent, ["disk_total"])}</small>
                  </div>
                </div>

                <dl class="node-meta public-node-meta">
                  <div><dt>总流量</dt><dd>↑ {formatBytes(totalUpload(agent))} ↓ {formatBytes(totalDownload(agent))}</dd></div>
                  <div><dt>网络</dt><dd>↑ {formatSpeed(uploadSpeed(agent))} ↓ {formatSpeed(downloadSpeed(agent))}</dd></div>
                  <div><dt>运行时间</dt><dd>{formatUptime(agent)}</dd></div>
                </dl>
              </article>
            {/each}
          {/if}
        </section>
      {:else}
        <section class="table-card public-table-card">
          {#if publicAgents.length === 0}
          <div class="empty-state">
            <h2>暂无公开节点</h2>
            <p>后台创建并启用节点后，前台会自动显示非隐藏节点。</p>
          </div>
          {:else}
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>OS</th>
                    <th>状态</th>
                    <th>CPU</th>
                    <th>内存</th>
                    <th>网络</th>
                    <th>运行时间</th>
                  </tr>
                </thead>
                <tbody>
                  {#each publicAgents as agent}
                    <tr>
                      <td><strong>{flagForAgent(agent)} {agent.name}</strong></td>
                      <td>{osName(agent)} / {archName(agent)}</td>
                      <td><span class:online={agent.online} class="badge">{agent.online ? "在线" : "离线"}</span></td>
                      <td>{formatPercent(cpuPercent(agent))}</td>
                      <td>{formatPercent(memoryPercent(agent))}</td>
                      <td>↑ {formatSpeed(uploadSpeed(agent))}<br />↓ {formatSpeed(downloadSpeed(agent))}</td>
                      <td>{formatUptime(agent)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>
      {/if}
    </section>
  </main>
{:else if route === "/admin/init"}
  <main class="auth-shell">
    <section class="auth-card">
      <div class="brand-line">
        <div class="brand-mark">D</div>
        <div>
          <strong>Daoyi Monitor</strong>
          <span>First setup</span>
        </div>
      </div>
      <h1>创建管理员</h1>
      <p class="muted">
        {#if $initStatus?.schemaReady}
          当前实例尚未初始化。创建第一位管理员后，即可进入监控面板。
        {:else}
          D1 数据表尚未就绪，请先执行数据库迁移。
        {/if}
      </p>

      {#if notice}
        <div class={`notice ${notice.kind}`}>{notice.message}</div>
      {/if}

      <form class="form-stack" on:submit|preventDefault={() => void submitInit()}>
        <label>
          用户名
          <input bind:value={initUsername} name="username" autocomplete="username" placeholder="root" />
        </label>
        <label>
          密码
          <input bind:value={initPassword} name="password" type="password" autocomplete="new-password" placeholder="至少 8 位" />
        </label>
        <label>
          确认密码
          <input bind:value={initPasswordConfirm} name="password_confirm" type="password" autocomplete="new-password" />
        </label>
        <div class="button-row">
          <button class="btn primary" disabled={initSubmitting || !$initStatus?.schemaReady}>
            {initSubmitting ? "创建中..." : "创建管理员"}
          </button>
          <button class="btn soft" type="button" on:click={() => void bootstrap()}>刷新状态</button>
        </div>
      </form>
    </section>
  </main>
{:else if route === "/admin/login"}
  <main class="auth-shell">
    <section class="auth-card">
      <div class="brand-line">
        <div class="brand-mark">D</div>
        <div>
          <strong>Daoyi Monitor</strong>
          <span>Admin sign in</span>
        </div>
      </div>
      <h1>登录</h1>
      <p class="muted">登录后可查看实时节点状态，并管理 Agent 与通知。</p>

      {#if notice}
        <div class={`notice ${notice.kind}`}>{notice.message}</div>
      {/if}

      <form class="form-stack" on:submit|preventDefault={() => void submitLogin()}>
        <label>
          用户名
          <input bind:value={loginUsername} name="username" autocomplete="username" placeholder="root" />
        </label>
        <label>
          密码
          <input bind:value={loginPassword} name="password" type="password" autocomplete="current-password" />
        </label>
        <div class="button-row">
          <button class="btn primary" disabled={loginSubmitting || $sessionLoading}>
            {loginSubmitting ? "登录中..." : "登录"}
          </button>
          <button class="btn soft" type="button" on:click={() => void bootstrap()}>刷新状态</button>
        </div>
      </form>
    </section>
  </main>
{:else}
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-line">
        <div class="brand-mark">D</div>
        <div>
          <strong>Daoyi Monitor</strong>
          <span>MIT server monitor</span>
        </div>
      </div>
      <nav class="top-nav" aria-label="主导航">
        <button class:active={route === "/admin"} on:click={() => navigate("/admin")}>总览</button>
        <button class:active={route === "/admin/agents"} on:click={() => navigate("/admin/agents")}>节点</button>
        <button class:active={route === "/admin/settings"} on:click={() => navigate("/admin/settings")}>通知</button>
      </nav>
      <div class="top-actions">
        <button class="btn soft" on:click={() => navigate("/")}>前台</button>
        <span class="user-pill">{$currentUser?.username ?? "admin"}</span>
        <button class="icon-btn" disabled={$sessionLoading} title="退出" on:click={() => void submitLogout()}>↪</button>
      </div>
    </header>

    <div class="main-grid">
      <aside class="admin-sidebar">
        <button class:active={route === "/admin"} on:click={() => navigate("/admin")}>
          <span class="side-icon overview" aria-hidden="true"></span>
          概览
        </button>
        <button class:active={route === "/admin/agents"} on:click={() => navigate("/admin/agents")}>
          <span class="side-icon nodes" aria-hidden="true"></span>
          客户端
        </button>
        <button class:active={route === "/admin/settings"} on:click={() => navigate("/admin/settings")}>
          <span class="side-icon notify" aria-hidden="true"></span>
          通知
        </button>
        <div class="sidebar-foot">
          <span>最近上报</span>
          <strong>{formatRelativeAge(lastReportAt)}</strong>
        </div>
      </aside>

      <section class="content">
        {#if notice}
          <div class={`notice ${notice.kind}`}>{notice.message}</div>
        {/if}

        {#if revealedSecret}
          <section class="secret-panel">
            <div>
              <span class="section-kicker">{revealedSecret.title}</span>
              <h2>{revealedSecret.name}</h2>
              <p>此 token 只显示一次。复制下面命令到服务器执行，即可安装并启动 Agent。</p>
            </div>
            <span class="secret-label">Token</span>
            <code>{revealedSecret.token || "后端未返回明文 token"}</code>
            {#if revealedSecret.token}
              <span class="secret-label">一键安装命令</span>
              <code class="install-command">{buildInstallCommand(revealedSecret.token)}</code>
            {/if}
            <div class="button-row">
              <button class="btn primary" disabled={copyingSecret || !revealedSecret.token} on:click={() => void copySecret()}>
                {copyingSecret ? "复制中..." : "复制 Token"}
              </button>
              <button class="btn primary" disabled={copyingInstallCommand || !revealedSecret.token} on:click={() => void copyInstallCommand()}>
                {copyingInstallCommand ? "复制中..." : "复制安装命令"}
              </button>
              <button class="btn soft" on:click={() => (revealedSecret = null)}>关闭</button>
            </div>
          </section>
        {/if}

        {#if route === "/admin"}
          <section class="summary-card">
            <div class="summary-head">
              <div>
                <span class="section-kicker">Overview</span>
                <h1>服务器状态</h1>
              </div>
              <button class="icon-btn" title="刷新" disabled={$agentsLoading} on:click={() => void refreshAgents()}>
                {$agentsLoading ? "…" : "↻"}
              </button>
            </div>
            <div class="status-grid">
              <article>
                <span>当前在线</span>
                <strong>{onlineCount} / {$agents.length}</strong>
              </article>
              <article>
                <span>节点分组</span>
                <strong>{groupCount}</strong>
              </article>
              <article>
                <span>平均 CPU</span>
                <strong>{formatPercent(cpuAverage)}</strong>
              </article>
              <article>
                <span>平均内存</span>
                <strong>{formatPercent(memoryAverage)}</strong>
              </article>
              <article>
                <span>隐藏节点</span>
                <strong>{hiddenCount}</strong>
              </article>
            </div>
          </section>

          <section class="node-grid">
            {#if previewAgents.length === 0}
              <div class="empty-state">
                <h2>暂无节点</h2>
                <p>先创建客户端，复制 token 后部署 Agent。</p>
                <button class="btn primary" on:click={() => ((createOpen = true), navigate("/admin/agents"))}>新建节点</button>
              </div>
            {:else}
              {#each previewAgents as agent}
                <article class="node-card">
                  <div class="node-head">
                    <div class="node-title">
                      <span class="node-dot" class:online={agent.online}></span>
                      <div>
                        <h2>{agent.name}</h2>
                        <p>{agent.group_name ?? "default"} / {agent.agent_id}</p>
                      </div>
                    </div>
                    <span class:online={agent.online} class="badge">{agent.online ? "Online" : "Offline"}</span>
                  </div>

                  <div class="tag-row">
                    {#each splitTags(agent.tags) as tag}
                      <span>{tag}</span>
                    {/each}
                    {#if agent.hidden}
                      <span>hidden</span>
                    {/if}
                    {#if !agent.enabled}
                      <span>disabled</span>
                    {/if}
                  </div>

                  <div class="usage-list">
                    <div class="usage-row">
                      <span>CPU</span>
                      <div class="usage-bar"><i style={`width: ${percentWidth(cpuPercent(agent))}`}></i></div>
                      <strong>{formatPercent(cpuPercent(agent))}</strong>
                    </div>
                    <div class="usage-row">
                      <span>RAM</span>
                      <div class="usage-bar"><i style={`width: ${percentWidth(memoryPercent(agent))}`}></i></div>
                      <strong>{formatPercent(memoryPercent(agent))}</strong>
                    </div>
                    <div class="usage-row">
                      <span>Disk</span>
                      <div class="usage-bar"><i style={`width: ${percentWidth(diskPercent(agent))}`}></i></div>
                      <strong>{formatPercent(diskPercent(agent))}</strong>
                    </div>
                  </div>

                  <dl class="node-meta">
                    <div><dt>内存</dt><dd>{formatMetricBytes(agent, ["mem_used", "memory_used"])} / {formatMetricBytes(agent, ["mem_total", "memory_total"])}</dd></div>
                    <div><dt>网络</dt><dd>↑ {formatSpeed(uploadSpeed(agent))} ↓ {formatSpeed(downloadSpeed(agent))}</dd></div>
                    <div><dt>运行</dt><dd>{formatUptime(agent)}</dd></div>
                    <div><dt>更新</dt><dd>{formatRelativeAge(agent.last_seen)}</dd></div>
                  </dl>
                </article>
              {/each}
            {/if}
          </section>
        {:else if route === "/admin/agents"}
          <section class="page-head">
            <div>
              <span class="section-kicker">Clients</span>
              <h1>客户端管理</h1>
              <p>创建节点、保存 token、轮换 token。远程终端与任务下发不在本项目内。</p>
            </div>
            <div class="button-row">
              <button class="btn primary" on:click={() => (createOpen = !createOpen)}>
                {createOpen ? "收起" : "新建客户端"}
              </button>
              <button class="btn soft" disabled={$agentsLoading} on:click={() => void refreshAgents()}>
                {$agentsLoading ? "刷新中..." : "刷新"}
              </button>
            </div>
          </section>

          {#if createOpen}
            <section class="setting-panel">
              <div class="panel-title">
                <h2>新建客户端</h2>
                <p>创建后 token 只显示一次。</p>
              </div>
              <form class="form-grid" on:submit|preventDefault={() => void submitCreateAgent()}>
                <label>节点名称<input bind:value={createName} name="agent_name" placeholder="edge-01" /></label>
                <label>分组<input bind:value={createGroup} name="agent_group" placeholder="default" /></label>
                <label>标签<input bind:value={createTags} name="agent_tags" placeholder="linux,edge" /></label>
                <label>权重<input bind:value={createWeight} name="agent_weight" type="number" step="1" /></label>
                <label class="full">内部备注<textarea bind:value={createRemark} name="agent_remark" rows="3"></textarea></label>
                <label class="full">公开备注<textarea bind:value={createPublicRemark} name="agent_public_remark" rows="3"></textarea></label>
                <label class="switch"><input bind:checked={createEnabled} name="agent_enabled" type="checkbox" />启用</label>
                <label class="switch"><input bind:checked={createHidden} name="agent_hidden" type="checkbox" />隐藏</label>
                <div class="button-row full">
                  <button class="btn primary" disabled={createSubmitting}>{createSubmitting ? "创建中..." : "创建"}</button>
                  <button class="btn soft" type="button" on:click={resetCreateForm}>清空</button>
                </div>
              </form>
            </section>
          {/if}

          <section class="table-card">
            <div class="table-head">
              <div>
                <h2>客户端</h2>
                <p>{$agents.length} 台，{onlineCount} 台在线</p>
              </div>
            </div>
            {#if $agents.length === 0}
              <div class="empty-state compact">
                <h2>暂无客户端</h2>
                <p>点击“新建客户端”开始。</p>
              </div>
            {:else}
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>状态</th>
                      <th>CPU</th>
                      <th>内存</th>
                      <th>网络</th>
                      <th>Token</th>
                      <th>最后上报</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each $agents as agent}
                      <tr>
                        <td>
                          <div class="name-cell">
                            <strong>{agent.name}</strong>
                            <span>{agent.group_name ?? "default"} / {agent.agent_id}</span>
                          </div>
                        </td>
                        <td><span class:online={agent.online} class="badge">{agent.online ? "Online" : "Offline"}</span></td>
                        <td>
                          <div class="mini-meter"><i style={`width: ${percentWidth(cpuPercent(agent))}`}></i></div>
                          <small>{formatPercent(cpuPercent(agent))}</small>
                        </td>
                        <td>
                          <div class="mini-meter"><i style={`width: ${percentWidth(memoryPercent(agent))}`}></i></div>
                          <small>{formatPercent(memoryPercent(agent))}</small>
                        </td>
                        <td>↑ {formatSpeed(uploadSpeed(agent))}<br />↓ {formatSpeed(downloadSpeed(agent))}</td>
                        <td><code class="token-code">{formatTokenPreview(agent.token_preview)}</code></td>
                        <td>{formatRelativeAge(agent.last_seen)}<br /><small>{formatLastSeen(agent.last_seen)}</small></td>
                        <td>
                          <div class="row-actions">
                            <button class="btn tiny soft" disabled={rotateTargetId === agent.id} on:click={() => void rotateToken(agent)}>
                              {rotateTargetId === agent.id ? "轮换中" : "轮换"}
                            </button>
                            <button class="btn tiny danger" on:click={() => ((deleteTarget = agent), (deleteConfirm = ""))}>删除</button>
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
          <section class="page-head">
            <div>
              <span class="section-kicker">Notification</span>
              <h1>通知设置</h1>
              <p>当前仅保留 Webhook 与 Telegram。离线、恢复等事件由 Worker 定时巡检触发。</p>
            </div>
            <button class="btn soft" disabled={$notificationSettingsLoading} on:click={() => void loadNotificationSettings().then(syncNotificationForm)}>
              {$notificationSettingsLoading ? "读取中..." : "重读"}
            </button>
          </section>

          <section class="setting-panel">
            <form class="settings-list" on:submit|preventDefault={() => void submitNotificationSettings()}>
              <label class="setting-row">
                <span><strong>启用通知</strong><small>总开关关闭时不发送任何消息。</small></span>
                <input bind:checked={notificationForm.enabled} name="notification_enabled" type="checkbox" />
              </label>
              <label class="setting-row">
                <span><strong>Webhook</strong><small>向兼容 HTTP Webhook 的系统推送 JSON。</small></span>
                <input bind:checked={notificationForm.webhook_enabled} name="webhook_enabled" type="checkbox" />
              </label>
              <label class="field-row">
                <span>Webhook URL</span>
                <input bind:value={notificationForm.webhook_url} name="webhook_url" placeholder="https://example.com/webhook" />
              </label>
              <label class="setting-row">
                <span><strong>Telegram</strong><small>通过 Bot API 发送到指定 Chat ID。</small></span>
                <input bind:checked={notificationForm.telegram_enabled} name="telegram_enabled" type="checkbox" />
              </label>
              <label class="field-row">
                <span>Bot Token</span>
                <input bind:value={notificationForm.telegram_bot_token} name="telegram_bot_token" type="password" placeholder="123456:ABC..." />
              </label>
              <label class="field-row">
                <span>Chat ID</span>
                <input bind:value={notificationForm.telegram_chat_id} name="telegram_chat_id" placeholder="-1001234567890" />
              </label>
              <div class="button-row">
                <button class="btn primary" disabled={notificationSaving}>
                  {notificationSaving ? "保存中..." : "保存"}
                </button>
                <button class="btn soft" type="button" disabled={notificationTesting || notificationSaving || !notificationForm.enabled} on:click={() => void sendTestNotification()}>
                  {notificationTesting ? "发送中..." : "发送测试"}
                </button>
              </div>
            </form>
          </section>
        {/if}
      </section>
    </div>
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
    <span class="section-kicker danger-text">Danger</span>
    <h2>删除 {deleteTarget.name}</h2>
    <p>此操作不可恢复。请输入节点 ID <code>{deleteTarget.agent_id}</code> 确认。</p>
    <label>
      节点 ID
      <input bind:value={deleteConfirm} name="delete_confirm" placeholder={deleteTarget.agent_id} />
    </label>
    <div class="button-row">
      <button class="btn danger" disabled={deleteSubmitting} on:click={() => void confirmDeleteAgent()}>
        {deleteSubmitting ? "删除中..." : "确认删除"}
      </button>
      <button class="btn soft" disabled={deleteSubmitting} on:click={() => (deleteTarget = null)}>取消</button>
    </div>
  </section>
{/if}
