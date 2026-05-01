import "@radix-ui/themes/styles.css";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Flex,
  IconButton,
  SegmentedControl,
  Separator,
  Switch,
  Text,
  TextArea,
  TextField,
  Theme
} from "@radix-ui/themes";
import {
  Activity,
  Bell,
  Copy,
  Grid3X3,
  Home,
  KeyRound,
  LogOut,
  Menu,
  Monitor,
  Plus,
  RefreshCcw,
  Search,
  Settings,
  Table2,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, apiDelete, apiGet, apiPost, apiPut } from "./api/client";
import { connectAdminWs, type WebSocketController } from "./api/ws";
import type {
  AdminEvent,
  AgentCreateInput,
  AgentMutationResult,
  AgentRecord,
  AgentStatus,
  InitStatus,
  NotificationConfig,
  User
} from "./types";

type Route = "/" | "/admin" | "/admin/agents" | "/admin/settings" | "/admin/init" | "/admin/login";
type Notice = { kind: "error" | "success"; message: string };
type RevealedSecret = { title: string; name: string; token: string };
type ViewMode = "grid" | "table";

const MEMORY_USED_KEYS = ["mem_used", "memory_used", "memory_used_bytes"];
const MEMORY_TOTAL_KEYS = ["mem_total", "memory_total", "memory_total_bytes"];

export default function App() {
  const [route, setRoute] = useState<Route>(() => currentRoute());
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [clock, setClock] = useState(new Date());
  const [initStatus, setInitStatus] = useState<InitStatus | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [publicSearch, setPublicSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => readStorage<ViewMode>("nodeViewMode", "grid"));
  const [selectedGroup, setSelectedGroup] = useState(() => readStorage<string>("nodeSelectedGroup", "all"));
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    group_name: "default",
    tags: "linux,x86_64",
    weight: 0,
    remark: "",
    public_remark: "",
    enabled: true,
    hidden: false
  });
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [rotateTargetId, setRotateTargetId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AgentRecord | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [revealedSecret, setRevealedSecret] = useState<RevealedSecret | null>(null);
  const [copyingToken, setCopyingToken] = useState(false);
  const [copyingInstall, setCopyingInstall] = useState(false);
  const [notificationForm, setNotificationForm] = useState(defaultNotificationConfig());
  const [notificationSaving, setNotificationSaving] = useState(false);
  const wsRef = useRef<WebSocketController | null>(null);

  const visibleAgents = useMemo(() => agents.filter((agent) => !agent.hidden), [agents]);
  const sortedVisibleAgents = useMemo(() => [...visibleAgents].sort(compareAgents), [visibleAgents]);
  const publicAgents = useMemo(
    () => sortedVisibleAgents.filter((agent) => matchesSearch(agent, publicSearch)),
    [sortedVisibleAgents, publicSearch]
  );
  const groups = useMemo(() => {
    const set = new Set(sortedVisibleAgents.map((agent) => agent.group_name ?? "default").filter(Boolean));
    return [...set].sort();
  }, [sortedVisibleAgents]);
  const filteredPublicAgents = useMemo(() => {
    if (selectedGroup === "all") return publicAgents;
    return publicAgents.filter((agent) => (agent.group_name ?? "default") === selectedGroup);
  }, [publicAgents, selectedGroup]);
  const onlineCount = visibleAgents.filter((agent) => agent.online).length;
  const publicOnlineCount = filteredPublicAgents.filter((agent) => agent.online).length;
  const cpuAverage = averageMetricAny(visibleAgents, ["cpu", "cpu_percent"]);
  const memoryAverage = averageRatioAny(visibleAgents, MEMORY_USED_KEYS, MEMORY_TOTAL_KEYS);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPop);
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.clearInterval(timer);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("nodeViewMode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem("nodeSelectedGroup", selectedGroup);
  }, [selectedGroup]);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | undefined;

    async function run() {
      setLoading(true);
      setNotice(null);
      wsRef.current?.close();
      wsRef.current = null;

      try {
        const status = await apiGet<InitStatus>("/api/init/status");
        if (cancelled) return;
        setInitStatus(status);

        if (!isAdminRoute(route)) {
          if (status.schemaReady) {
            await loadPublicAgents();
            refreshTimer = window.setInterval(() => void loadPublicAgents(false), 30_000);
          }
          return;
        }

        if (!status.initialized && route !== "/admin/init") {
          navigate("/admin/init");
          return;
        }

        if (status.initialized && route === "/admin/init") {
          navigate("/admin/login");
          return;
        }

        if (route === "/admin/init") return;

        const me = await loadMeSafe();
        if (cancelled) return;
        setUser(me);
        if (!me && route !== "/admin/login") {
          navigate("/admin/login");
          return;
        }

        if (!me) return;
        if (route === "/admin/login") {
          navigate("/admin");
          return;
        }

        await Promise.all([loadAdminAgents(), loadNotifications()]);
        wsRef.current = connectAdminWs((event) => setAgents((items) => applyRealtimeEvent(items, event)));
      } catch (error) {
        if (!cancelled) setNotice({ kind: "error", message: toErrorMessage(error) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [route]);

  const loadPublicAgents = useCallback(async (withSpinner = true) => {
    if (withSpinner) setAgentsLoading(true);
    try {
      const payload = await apiGet<unknown>("/api/public/agents");
      setAgents(readAgentList(payload).map(normalizeAgentRecord).sort(compareAgents));
    } finally {
      if (withSpinner) setAgentsLoading(false);
    }
  }, []);

  const loadAdminAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const payload = await apiGet<unknown>("/api/agents");
      setAgents(readAgentList(payload).map(normalizeAgentRecord).sort(compareAgents));
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    const settings = await apiGet<NotificationConfig>("/api/settings/notifications");
    setNotificationForm(settings);
  }, []);

  async function loadMeSafe(): Promise<User | null> {
    try {
      const payload = await apiGet<User | { user: User } | null>("/api/auth/me");
      if (!payload) return null;
      return "user" in payload ? payload.user : payload;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) return null;
      throw error;
    }
  }

  function navigate(next: Route) {
    if (next === route) return;
    window.history.pushState({}, "", next);
    setRoute(next);
  }

  async function submitInit(username: string, password: string, confirm: string) {
    if (!username.trim()) return setNotice({ kind: "error", message: "管理员用户名不可为空。" });
    if (password.length < 8) return setNotice({ kind: "error", message: "密码至少 8 位。" });
    if (password !== confirm) return setNotice({ kind: "error", message: "两次密码不一致。" });
    await apiPost("/api/init/admin", { username: username.trim(), password });
    setNotice({ kind: "success", message: "管理员已创建。" });
    navigate("/admin/login");
  }

  async function submitLogin(username: string, password: string) {
    const payload = await apiPost<User | { user: User }>("/api/auth/login", { username, password });
    setUser("user" in payload ? payload.user : payload);
    setNotice({ kind: "success", message: "登录成功。" });
    navigate("/admin");
  }

  async function submitLogout() {
    await apiPost("/api/auth/logout");
    setUser(null);
    setAgents([]);
    setRevealedSecret(null);
    navigate("/admin/login");
  }

  async function submitCreateAgent() {
    const name = createForm.name.trim();
    if (!name) return setNotice({ kind: "error", message: "节点名称不可为空。" });
    setCreateSubmitting(true);
    try {
      const input: AgentCreateInput = {
        name,
        enabled: createForm.enabled,
        hidden: createForm.hidden,
        weight: Number(createForm.weight) || 0,
        group_name: emptyToNull(createForm.group_name),
        tags: emptyToNull(createForm.tags),
        remark: emptyToNull(createForm.remark),
        public_remark: emptyToNull(createForm.public_remark)
      };
      const result = normalizeMutationResult(await apiPost<unknown>("/api/agents", input));
      setAgents((items) => upsertAgent(items, result.agent).sort(compareAgents));
      setRevealedSecret({ title: "新节点 Token", name: result.agent.name, token: result.token });
      setCreateOpen(false);
      setCreateForm({ name: "", group_name: "default", tags: "linux,x86_64", weight: 0, remark: "", public_remark: "", enabled: true, hidden: false });
      setNotice({ kind: "success", message: `节点 ${result.agent.name} 已创建。` });
    } catch (error) {
      setNotice({ kind: "error", message: toErrorMessage(error) });
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function rotateToken(agent: AgentRecord) {
    setRotateTargetId(agent.id);
    try {
      const result = normalizeMutationResult(await apiPost<unknown>(`/api/agents/${encodeURIComponent(agent.id)}/token/rotate`));
      setAgents((items) => upsertAgent(items, result.agent).sort(compareAgents));
      setRevealedSecret({ title: "轮换后的 Token", name: result.agent.name, token: result.token });
      setNotice({ kind: "success", message: `节点 ${result.agent.name} 的 token 已轮换。` });
    } catch (error) {
      setNotice({ kind: "error", message: toErrorMessage(error) });
    } finally {
      setRotateTargetId("");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteConfirm.trim() !== deleteTarget.agent_id) {
      return setNotice({ kind: "error", message: "请键入完整节点 ID 以确认删除。" });
    }
    await apiDelete(`/api/agents/${encodeURIComponent(deleteTarget.id)}`, { confirm: deleteConfirm.trim() });
    setAgents((items) => items.filter((item) => item.id !== deleteTarget.id));
    setDeleteTarget(null);
    setDeleteConfirm("");
    setNotice({ kind: "success", message: "节点已删除。" });
  }

  async function saveNotifications() {
    setNotificationSaving(true);
    try {
      const settings = await apiPut<NotificationConfig>("/api/settings/notifications", {
        ...notificationForm,
        webhook_url: emptyToNull(notificationForm.webhook_url ?? ""),
        telegram_bot_token: emptyToNull(notificationForm.telegram_bot_token ?? ""),
        telegram_chat_id: emptyToNull(notificationForm.telegram_chat_id ?? "")
      });
      setNotificationForm(settings);
      setNotice({ kind: "success", message: "通知设置已保存。" });
    } catch (error) {
      setNotice({ kind: "error", message: toErrorMessage(error) });
    } finally {
      setNotificationSaving(false);
    }
  }

  async function testNotifications() {
    try {
      await apiPost("/api/settings/notifications/test");
      setNotice({ kind: "success", message: "测试通知已发出。" });
    } catch (error) {
      setNotice({ kind: "error", message: toErrorMessage(error) });
    }
  }

  async function copyText(value: string, kind: "token" | "install") {
    if (kind === "token") setCopyingToken(true);
    if (kind === "install") setCopyingInstall(true);
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ kind: "success", message: kind === "token" ? "Token 已复制。" : "安装命令已复制。" });
    } catch {
      setNotice({ kind: "error", message: "复制失败，请手动复制。" });
    } finally {
      setCopyingToken(false);
      setCopyingInstall(false);
    }
  }

  const content = !isAdminRoute(route) ? (
    <PublicPage
      agents={filteredPublicAgents}
      allCount={publicAgents.length}
      onlineCount={publicOnlineCount}
      clock={clock}
      search={publicSearch}
      setSearch={setPublicSearch}
      groups={groups}
      selectedGroup={selectedGroup}
      setSelectedGroup={setSelectedGroup}
      viewMode={viewMode}
      setViewMode={setViewMode}
      loading={agentsLoading}
      refresh={() => void loadPublicAgents()}
      navigate={navigate}
    />
  ) : route === "/admin/init" ? (
    <InitPage loading={loading} onSubmit={(username, password, confirm) => void submitInit(username, password, confirm)} />
  ) : route === "/admin/login" ? (
    <LoginPage loading={loading} onSubmit={(username, password) => void submitLogin(username, password)} />
  ) : (
    <AdminShell route={route} navigate={navigate} user={user} onLogout={() => void submitLogout()}>
      {notice && <NoticeBanner notice={notice} />}
      {revealedSecret && (
        <SecretPanel
          secret={revealedSecret}
          copyingToken={copyingToken}
          copyingInstall={copyingInstall}
          onCopyToken={() => void copyText(revealedSecret.token, "token")}
          onCopyInstall={() => void copyText(buildInstallCommand(revealedSecret.token), "install")}
          onClose={() => setRevealedSecret(null)}
        />
      )}
      {route === "/admin" && (
        <Dashboard agents={visibleAgents} onlineCount={onlineCount} cpuAverage={cpuAverage} memoryAverage={memoryAverage} refresh={() => void loadAdminAgents()} />
      )}
      {route === "/admin/agents" && (
        <AgentsPage
          agents={agents}
          onlineCount={onlineCount}
          loading={agentsLoading}
          createOpen={createOpen}
          setCreateOpen={setCreateOpen}
          createForm={createForm}
          setCreateForm={setCreateForm}
          createSubmitting={createSubmitting}
          submitCreateAgent={() => void submitCreateAgent()}
          rotateTargetId={rotateTargetId}
          rotateToken={(agent) => void rotateToken(agent)}
          setDeleteTarget={setDeleteTarget}
          refresh={() => void loadAdminAgents()}
        />
      )}
      {route === "/admin/settings" && (
        <NotificationsPage
          form={notificationForm}
          setForm={setNotificationForm}
          saving={notificationSaving}
          save={() => void saveNotifications()}
          test={() => void testNotifications()}
        />
      )}
      <DeleteDialog
        agent={deleteTarget}
        confirm={deleteConfirm}
        setConfirm={setDeleteConfirm}
        onClose={() => setDeleteTarget(null)}
        onDelete={() => void confirmDelete()}
      />
    </AdminShell>
  );

  return (
    <Theme accentColor="indigo" grayColor="slate" radius="medium" scaling="100%">
      {loading && !initStatus ? <LoadingScreen /> : content}
    </Theme>
  );
}

function PublicPage(props: {
  agents: AgentRecord[];
  allCount: number;
  onlineCount: number;
  clock: Date;
  search: string;
  setSearch: (value: string) => void;
  groups: string[];
  selectedGroup: string;
  setSelectedGroup: (value: string) => void;
  viewMode: ViewMode;
  setViewMode: (value: ViewMode) => void;
  loading: boolean;
  refresh: () => void;
  navigate: (route: Route) => void;
}) {
  const up = sumMetricAny(props.agents, ["network_total_up", "net_total_up", "total_upload", "tx_total"]);
  const down = sumMetricAny(props.agents, ["network_total_down", "net_total_down", "total_download", "rx_total"]);
  const speedUp = sumMetricAny(props.agents, ["network_up", "net_up", "upload_bps", "tx_bps"]);
  const speedDown = sumMetricAny(props.agents, ["network_down", "net_down", "download_bps", "rx_bps"]);

  return (
    <main className="min-h-screen bg-[var(--accent-1)] text-[var(--gray-12)]">
      <nav className="sticky top-0 z-10 border-b border-[var(--gray-5)] bg-[var(--accent-1)]/90 backdrop-blur">
        <Flex justify="between" align="center" className="mx-auto max-w-7xl px-4 py-2">
          <Flex align="center" gap="3">
            <div className="brand-mark">D</div>
            <div>
              <Text weight="bold" size="5">Daoyi Monitor</Text>
              <Text as="div" size="1" color="gray">Komari Monitor</Text>
            </div>
          </Flex>
          <Flex gap="2">
            <IconButton variant="ghost" title="刷新" onClick={props.refresh} disabled={props.loading}><RefreshCcw size={16} /></IconButton>
            <Button variant="soft" onClick={() => props.navigate("/admin")}>后台管理</Button>
          </Flex>
        </Flex>
      </nav>

      <div className="mx-auto max-w-7xl py-4">
        <Card className="mx-4">
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
            <TopCard title="当前时间" value={props.clock.toLocaleTimeString("zh-CN", { hour12: false })} />
            <TopCard title="当前在线" value={`${props.onlineCount} / ${props.allCount}`} />
            <TopCard title="点亮分组" value={new Set(props.agents.map((agent) => agent.group_name ?? "default")).size} />
            <TopCard title="流量概览" value={`↑ ${formatBytes(up)} / ↓ ${formatBytes(down)}`} />
            <TopCard title="网络速率" value={`↑ ${formatSpeed(speedUp)} / ↓ ${formatSpeed(speedDown)}`} />
          </div>
        </Card>

        <NodeDisplay
          agents={props.agents}
          total={props.allCount}
          online={props.onlineCount}
          search={props.search}
          setSearch={props.setSearch}
          groups={props.groups}
          selectedGroup={props.selectedGroup}
          setSelectedGroup={props.setSelectedGroup}
          viewMode={props.viewMode}
          setViewMode={props.setViewMode}
        />
      </div>
    </main>
  );
}

function NodeDisplay(props: {
  agents: AgentRecord[];
  total: number;
  online: number;
  search: string;
  setSearch: (value: string) => void;
  groups: string[];
  selectedGroup: string;
  setSelectedGroup: (value: string) => void;
  viewMode: ViewMode;
  setViewMode: (value: ViewMode) => void;
}) {
  return (
    <div className="w-full">
      <Flex direction={{ initial: "column", sm: "row" }} justify="between" align={{ initial: "stretch", sm: "center" }} gap="4" className="mx-4 my-4 rounded-lg p-1">
        <TextField.Root
          id="public-search"
          name="search"
          placeholder="搜索节点名称、地区、系统..."
          value={props.search}
          onChange={(event) => props.setSearch(event.target.value)}
          className="max-w-md flex-1"
        >
          <TextField.Slot><Search size={16} /></TextField.Slot>
          {props.search && <TextField.Slot><IconButton size="1" variant="ghost" onClick={() => props.setSearch("")}><X size={12} /></IconButton></TextField.Slot>}
        </TextField.Root>
        <Flex align="center" gap="2">
          <Text size="2" color="gray">显示模式</Text>
          <IconButton variant={props.viewMode === "grid" ? "solid" : "soft"} onClick={() => props.setViewMode("grid")}><Grid3X3 size={16} /></IconButton>
          <IconButton variant={props.viewMode === "table" ? "solid" : "soft"} onClick={() => props.setViewMode("table")}><Table2 size={16} /></IconButton>
        </Flex>
      </Flex>
      {props.groups.length > 0 && (
        <Flex align="center" gap="2" className="mx-4 mb-2 overflow-x-auto">
          <Text size="2" color="gray">分组</Text>
          <SegmentedControl.Root value={props.selectedGroup} onValueChange={props.setSelectedGroup} size="1">
            <SegmentedControl.Item value="all">所有</SegmentedControl.Item>
            {props.groups.map((group) => <SegmentedControl.Item key={group} value={group}>{group}</SegmentedControl.Item>)}
          </SegmentedControl.Root>
        </Flex>
      )}
      <Flex justify="between" className="mx-4 mb-2">
        <Text size="2" color="gray">共 {props.total} 个服务器，{props.online} 个在线</Text>
      </Flex>
      {props.viewMode === "grid" ? (
        <div className="grid w-full gap-4 p-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {props.agents.map((agent) => <NodeCard key={agent.id} agent={agent} />)}
        </div>
      ) : (
        <NodeTable agents={props.agents} />
      )}
    </div>
  );
}

function NodeCard({ agent }: { agent: AgentRecord }) {
  const memPct = memoryPercent(agent);
  const diskPct = diskPercent(agent);
  return (
    <Card className="node-card hover:bg-[var(--accent-2)]">
      <Flex direction="column" gap="2">
        <Flex justify="between" align="center">
          <Flex align="center" gap="2" className="min-w-0">
            <span className="text-xl">{flagForAgent(agent)}</span>
            <div className="min-w-0">
              <Text as="div" weight="bold" size="4" className="truncate">{agent.name}</Text>
              <Text as="div" size="1" color="gray" className="truncate">{tagLine(agent)}</Text>
            </div>
          </Flex>
          <Badge color={agent.online ? "green" : "red"} variant="soft">{agent.online ? "在线" : "离线"}</Badge>
        </Flex>
        <Separator size="4" />
        <InfoRow label="OS" value={osText(agent)} />
        <InfoRow label="地区" value={locationText(agent)} />
        <UsageBar label="CPU" value={cpuPercent(agent)} />
        <UsageBar label="内存" value={memPct} hint={`${formatMetricBytes(agent, MEMORY_USED_KEYS)} / ${formatMetricBytes(agent, MEMORY_TOTAL_KEYS)}`} />
        <UsageBar label="磁盘" value={diskPct} hint={`${formatMetricBytes(agent, ["disk_used", "disk_usage"])} / ${formatMetricBytes(agent, ["disk_total"])}`} />
        <InfoRow label="总流量" value={`↑ ${formatBytes(totalUpload(agent))} ↓ ${formatBytes(totalDownload(agent))}`} />
        <InfoRow label="网络" value={`↑ ${formatSpeed(uploadSpeed(agent))} ↓ ${formatSpeed(downloadSpeed(agent))}`} />
        <InfoRow label="运行时间" value={agent.online ? formatUptime(agent) : "-"} />
      </Flex>
    </Card>
  );
}

function NodeTable({ agents }: { agents: AgentRecord[] }) {
  return (
    <div className="mx-4 overflow-x-auto rounded-lg border border-[var(--gray-5)]">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="bg-[var(--accent-2)] text-[var(--gray-11)]">
          <tr>
            <th className="p-3 text-left">节点</th>
            <th className="p-3 text-left">状态</th>
            <th className="p-3 text-left">CPU</th>
            <th className="p-3 text-left">内存</th>
            <th className="p-3 text-left">网络</th>
            <th className="p-3 text-left">运行</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id} className="border-t border-[var(--gray-4)] hover:bg-[var(--accent-2)]">
              <td className="p-3"><Text weight="medium">{flagForAgent(agent)} {agent.name}</Text><Text as="div" size="1" color="gray">{locationText(agent)} · {osText(agent)}</Text></td>
              <td className="p-3"><Badge color={agent.online ? "green" : "red"} variant="soft">{agent.online ? "在线" : "离线"}</Badge></td>
              <td className="p-3">{formatPercent(cpuPercent(agent))}</td>
              <td className="p-3">{formatPercent(memoryPercent(agent))}</td>
              <td className="p-3">↑ {formatSpeed(uploadSpeed(agent))}<br />↓ {formatSpeed(downloadSpeed(agent))}</td>
              <td className="p-3">{formatUptime(agent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminShell({ route, navigate, user, onLogout, children }: { route: Route; navigate: (route: Route) => void; user: User | null; onLogout: () => void; children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const items = [
    { route: "/admin" as Route, label: "总览", icon: Activity },
    { route: "/admin/agents" as Route, label: "客户端", icon: Monitor },
    { route: "/admin/settings" as Route, label: "通知", icon: Bell }
  ];
  return (
    <div className="grid h-screen w-screen grid-rows-[auto_1fr] overflow-hidden bg-[var(--accent-3)] md:grid-cols-[auto_1fr]">
      <nav className="col-span-full border-b border-[var(--gray-5)] bg-[var(--accent-1)]">
        <Flex justify="between" align="center" className="px-3 py-2">
          <Flex gap="3" align="center">
            <IconButton variant="ghost" onClick={() => setSidebarOpen((value) => !value)}><Menu size={18} /></IconButton>
            <button className="text-xl font-bold" onClick={() => navigate("/")}>Daoyi</button>
            <Text size="1" color="gray">Cloudflare Monitor</Text>
          </Flex>
          <Flex gap="2" align="center">
            <Text size="2" color="gray">{user?.username ?? ""}</Text>
            <IconButton variant="soft" color="orange" onClick={onLogout}><LogOut size={16} /></IconButton>
          </Flex>
        </Flex>
      </nav>
      <aside className={`${sidebarOpen ? "w-[240px]" : "w-0"} overflow-hidden border-r border-[var(--gray-5)] bg-[var(--accent-1)] transition-[width]`}>
        <Flex direction="column" gap="1" className="h-full min-w-[240px] p-2">
          {items.map((item) => {
            const Icon = item.icon;
            const active = route === item.route;
            return (
              <button key={item.route} className={`sidebar-item ${active ? "active" : ""}`} onClick={() => navigate(item.route)}>
                <Icon size={16} /> <span>{item.label}</span>
              </button>
            );
          })}
          <button className="sidebar-item mt-auto" onClick={() => navigate("/")}>
            <Home size={16} /> <span>前台</span>
          </button>
        </Flex>
      </aside>
      <main className="overflow-auto bg-[var(--accent-1)] p-3 md:p-4">{children}</main>
    </div>
  );
}

function Dashboard({ agents, onlineCount, cpuAverage, memoryAverage, refresh }: { agents: AgentRecord[]; onlineCount: number; cpuAverage: number | null; memoryAverage: number | null; refresh: () => void }) {
  return (
    <div className="space-y-4">
      <Card>
        <Flex justify="between" align="center" mb="3">
          <div><Text size="1" color="gray">Overview</Text><Text as="div" size="6" weight="bold">服务器状态</Text></div>
          <IconButton variant="ghost" onClick={refresh}><RefreshCcw size={16} /></IconButton>
        </Flex>
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          <TopCard title="当前在线" value={`${onlineCount} / ${agents.length}`} />
          <TopCard title="节点分组" value={new Set(agents.map((agent) => agent.group_name ?? "default")).size} />
          <TopCard title="平均 CPU" value={formatPercent(cpuAverage)} />
          <TopCard title="平均内存" value={formatPercent(memoryAverage)} />
        </div>
      </Card>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
        {agents.slice(0, 8).map((agent) => <NodeCard key={agent.id} agent={agent} />)}
      </div>
    </div>
  );
}

function AgentsPage(props: {
  agents: AgentRecord[];
  onlineCount: number;
  loading: boolean;
  createOpen: boolean;
  setCreateOpen: (value: boolean) => void;
  createForm: { name: string; group_name: string; tags: string; weight: number; remark: string; public_remark: string; enabled: boolean; hidden: boolean };
  setCreateForm: React.Dispatch<React.SetStateAction<{ name: string; group_name: string; tags: string; weight: number; remark: string; public_remark: string; enabled: boolean; hidden: boolean }>>;
  createSubmitting: boolean;
  submitCreateAgent: () => void;
  rotateTargetId: string;
  rotateToken: (agent: AgentRecord) => void;
  setDeleteTarget: (agent: AgentRecord) => void;
  refresh: () => void;
}) {
  return (
    <div className="space-y-4">
      <Flex justify="between" align="center" gap="3" wrap="wrap">
        <div><Text size="1" color="gray">Clients</Text><Text as="div" size="6" weight="bold">客户端管理</Text></div>
        <Flex gap="2">
          <Button onClick={() => props.setCreateOpen(!props.createOpen)}><Plus size={16} />{props.createOpen ? "收起" : "新建客户端"}</Button>
          <Button variant="soft" disabled={props.loading} onClick={props.refresh}><RefreshCcw size={16} />刷新</Button>
        </Flex>
      </Flex>
      {props.createOpen && (
        <Card>
          <Text as="div" weight="bold" mb="3">新建客户端</Text>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="节点名称"><TextField.Root value={props.createForm.name} onChange={(event) => props.setCreateForm((form) => ({ ...form, name: event.target.value }))} placeholder="ccs2" /></Field>
            <Field label="分组"><TextField.Root value={props.createForm.group_name} onChange={(event) => props.setCreateForm((form) => ({ ...form, group_name: event.target.value }))} /></Field>
            <Field label="标签"><TextField.Root value={props.createForm.tags} onChange={(event) => props.setCreateForm((form) => ({ ...form, tags: event.target.value }))} /></Field>
            <Field label="权重"><TextField.Root type="number" value={String(props.createForm.weight)} onChange={(event) => props.setCreateForm((form) => ({ ...form, weight: Number(event.target.value) }))} /></Field>
            <Field label="内部备注" className="md:col-span-2"><TextArea value={props.createForm.remark} onChange={(event) => props.setCreateForm((form) => ({ ...form, remark: event.target.value }))} /></Field>
            <Field label="公开备注" className="md:col-span-2"><TextArea value={props.createForm.public_remark} onChange={(event) => props.setCreateForm((form) => ({ ...form, public_remark: event.target.value }))} /></Field>
            <Flex gap="4" align="center">
              <label className="flex items-center gap-2 text-sm"><Switch checked={props.createForm.enabled} onCheckedChange={(value) => props.setCreateForm((form) => ({ ...form, enabled: value }))} />启用</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={props.createForm.hidden} onCheckedChange={(value) => props.setCreateForm((form) => ({ ...form, hidden: value }))} />隐藏</label>
            </Flex>
            <Flex justify="end" className="md:col-span-3"><Button disabled={props.createSubmitting} onClick={props.submitCreateAgent}>{props.createSubmitting ? "创建中..." : "创建"}</Button></Flex>
          </div>
        </Card>
      )}
      <Card>
        <Flex justify="between" align="center" mb="3">
          <div><Text as="div" weight="bold">客户端</Text><Text size="2" color="gray">{props.agents.length} 台，{props.onlineCount} 台在线</Text></div>
        </Flex>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="text-[var(--gray-11)]">
              <tr><th className="p-2 text-left">名称</th><th className="p-2 text-left">状态</th><th className="p-2 text-left">CPU</th><th className="p-2 text-left">内存</th><th className="p-2 text-left">Token</th><th className="p-2 text-left">最后上报</th><th className="p-2 text-left">操作</th></tr>
            </thead>
            <tbody>
              {props.agents.map((agent) => (
                <tr key={agent.id} className="border-t border-[var(--gray-4)]">
                  <td className="p-2"><Text weight="medium">{agent.name}</Text><Text as="div" size="1" color="gray">{agent.group_name ?? "default"} / {agent.agent_id}</Text></td>
                  <td className="p-2"><Badge color={agent.online ? "green" : "red"} variant="soft">{agent.online ? "Online" : "Offline"}</Badge></td>
                  <td className="p-2">{formatPercent(cpuPercent(agent))}</td>
                  <td className="p-2">{formatPercent(memoryPercent(agent))}</td>
                  <td className="p-2"><code>{agent.token_preview}</code></td>
                  <td className="p-2">{formatRelativeAge(agent.last_seen)}<Text as="div" size="1" color="gray">{formatLastSeen(agent.last_seen)}</Text></td>
                  <td className="p-2">
                    <Flex gap="2">
                      <Button size="1" variant="soft" disabled={props.rotateTargetId === agent.id} onClick={() => props.rotateToken(agent)}><KeyRound size={14} />{props.rotateTargetId === agent.id ? "轮换中" : "轮换"}</Button>
                      <Button size="1" color="red" variant="soft" onClick={() => props.setDeleteTarget(agent)}><Trash2 size={14} />删除</Button>
                    </Flex>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function NotificationsPage({ form, setForm, saving, save, test }: { form: NotificationConfig; setForm: React.Dispatch<React.SetStateAction<NotificationConfig>>; saving: boolean; save: () => void; test: () => void }) {
  return (
    <div className="space-y-4">
      <Flex justify="between" align="center" gap="3" wrap="wrap">
        <div><Text size="1" color="gray">Notification</Text><Text as="div" size="6" weight="bold">通知设置</Text></div>
        <Flex gap="2"><Button variant="soft" onClick={test}>测试</Button><Button disabled={saving} onClick={save}>{saving ? "保存中..." : "保存"}</Button></Flex>
      </Flex>
      <Card className="space-y-4">
        <label className="flex items-center gap-2 text-sm"><Switch checked={form.enabled} onCheckedChange={(value) => setForm((item) => ({ ...item, enabled: value }))} />启用通知</label>
        <Separator size="4" />
        <label className="flex items-center gap-2 text-sm"><Switch checked={form.webhook_enabled} onCheckedChange={(value) => setForm((item) => ({ ...item, webhook_enabled: value }))} />Webhook</label>
        <Field label="Webhook URL"><TextField.Root value={form.webhook_url ?? ""} onChange={(event) => setForm((item) => ({ ...item, webhook_url: event.target.value }))} /></Field>
        <Separator size="4" />
        <label className="flex items-center gap-2 text-sm"><Switch checked={form.telegram_enabled} onCheckedChange={(value) => setForm((item) => ({ ...item, telegram_enabled: value }))} />Telegram</label>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Bot Token"><TextField.Root value={form.telegram_bot_token ?? ""} onChange={(event) => setForm((item) => ({ ...item, telegram_bot_token: event.target.value }))} /></Field>
          <Field label="Chat ID"><TextField.Root value={form.telegram_chat_id ?? ""} onChange={(event) => setForm((item) => ({ ...item, telegram_chat_id: event.target.value }))} /></Field>
        </div>
      </Card>
    </div>
  );
}

function InitPage({ loading, onSubmit }: { loading: boolean; onSubmit: (username: string, password: string, confirm: string) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  return <AuthFrame title="初始化" subtitle="创建第一个管理员账户。">
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(username, password, confirm); }}>
      <Field label="用户名"><TextField.Root id="init-username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></Field>
      <Field label="密码"><TextField.Root id="init-password" name="password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
      <Field label="确认密码"><TextField.Root id="init-password-confirm" name="password_confirm" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></Field>
      <Button type="submit" disabled={loading}>初始化</Button>
    </form>
  </AuthFrame>;
}

function LoginPage({ loading, onSubmit }: { loading: boolean; onSubmit: (username: string, password: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return <AuthFrame title="登录" subtitle="登录后查看实时节点状态，并管理 Agent 与通知。">
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(username, password); }}>
      <Field label="用户名"><TextField.Root id="login-username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></Field>
      <Field label="密码"><TextField.Root id="login-password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
      <Button type="submit" disabled={loading}>登录</Button>
    </form>
  </AuthFrame>;
}

function AuthFrame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--accent-1)] p-4">
      <Card className="w-full max-w-md">
        <Flex align="center" gap="3" mb="4"><div className="brand-mark">D</div><div><Text weight="bold" size="5">Daoyi Monitor</Text><Text as="div" size="1" color="gray">Admin sign in</Text></div></Flex>
        <Text as="div" size="6" weight="bold">{title}</Text>
        <Text as="p" size="2" color="gray" mb="4">{subtitle}</Text>
        <Flex direction="column" gap="3">{children}</Flex>
      </Card>
    </main>
  );
}

function SecretPanel({ secret, copyingToken, copyingInstall, onCopyToken, onCopyInstall, onClose }: { secret: RevealedSecret; copyingToken: boolean; copyingInstall: boolean; onCopyToken: () => void; onCopyInstall: () => void; onClose: () => void }) {
  const install = buildInstallCommand(secret.token);
  return (
    <Card className="mb-4 border-[var(--accent-7)] bg-[var(--accent-2)]">
      <Text size="1" color="gray">{secret.title}</Text>
      <Text as="div" size="5" weight="bold">{secret.name}</Text>
      <Text as="p" size="2" color="gray">Token 只显示一次。复制安装命令到服务器执行。</Text>
      <Text as="div" size="1" color="gray" mt="3">Token</Text>
      <code className="code-block">{secret.token}</code>
      <Text as="div" size="1" color="gray" mt="3">一键安装命令</Text>
      <code className="code-block whitespace-pre-wrap break-all">{install}</code>
      <Flex gap="2" mt="3" wrap="wrap">
        <Button onClick={onCopyToken} disabled={copyingToken}><Copy size={16} />{copyingToken ? "复制中..." : "复制 Token"}</Button>
        <Button onClick={onCopyInstall} disabled={copyingInstall}><Copy size={16} />{copyingInstall ? "复制中..." : "复制安装命令"}</Button>
        <Button variant="soft" onClick={onClose}>关闭</Button>
      </Flex>
    </Card>
  );
}

function DeleteDialog({ agent, confirm, setConfirm, onClose, onDelete }: { agent: AgentRecord | null; confirm: string; setConfirm: (value: string) => void; onClose: () => void; onDelete: () => void }) {
  return (
    <Dialog.Root open={Boolean(agent)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>删除节点</Dialog.Title>
        <Dialog.Description>键入完整节点 ID 以确认删除：{agent?.agent_id}</Dialog.Description>
        <TextField.Root value={confirm} onChange={(event) => setConfirm(event.target.value)} mt="3" />
        <Flex justify="end" gap="2" mt="4"><Button variant="soft" onClick={onClose}>取消</Button><Button color="red" onClick={onDelete}>删除</Button></Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function TopCard({ title, value }: { title: string; value: string | number }) {
  return <div className="min-w-52"><Text as="div" size="2" color="gray">{title}</Text><Text as="div" weight="medium" size="3">{value}</Text></div>;
}

function UsageBar({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  const next = value ?? 0;
  const color = next >= 80 ? "var(--red-9)" : next >= 60 ? "var(--orange-9)" : "var(--green-9)";
  return (
    <div className="w-full">
      <Flex justify="between" align="center"><Text size="2" color="gray">{label}</Text><Text size="2" weight="medium">{formatPercent(value)}</Text></Flex>
      <div className="mt-1 h-2 overflow-hidden rounded bg-[var(--gray-5)]"><div className="h-full rounded transition-[width]" style={{ width: `${Math.max(0, Math.min(100, next))}%`, backgroundColor: color }} /></div>
      {hint && <Text as="div" size="1" color="gray" mt="1">({hint})</Text>}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <Flex justify="between" gap="3"><Text size="2" color="gray">{label}</Text><Text size="2" className="text-right">{value}</Text></Flex>;
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`grid gap-1 text-sm ${className}`}><Text size="2" weight="medium">{label}</Text>{children}</label>;
}

function NoticeBanner({ notice }: { notice: Notice }) {
  return <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${notice.kind === "success" ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"}`}>{notice.message}</div>;
}

function LoadingScreen() {
  return <main className="grid min-h-screen place-items-center bg-[var(--accent-1)]"><Text color="gray">Loading...</Text></main>;
}

function currentRoute(): Route {
  const path = window.location.pathname;
  if (path === "/admin" || path === "/admin/agents" || path === "/admin/settings" || path === "/admin/init" || path === "/admin/login") return path;
  return "/";
}

function isAdminRoute(route: Route) {
  return route.startsWith("/admin");
}

function readStorage<T extends string>(key: string, fallback: T): T {
  const value = localStorage.getItem(key);
  return (value || fallback) as T;
}

function matchesSearch(agent: AgentRecord, search: string) {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  return [agent.name, agent.group_name, agent.tags, agent.public_remark, osText(agent), locationText(agent), agent.online ? "在线 online" : "离线 offline"]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(term));
}

function compareAgents(left: AgentRecord, right: AgentRecord) {
  if (left.online !== right.online) return Number(right.online) - Number(left.online);
  if (left.weight !== right.weight) return left.weight - right.weight;
  return left.name.localeCompare(right.name, "zh-Hans-CN");
}

function applyRealtimeEvent(items: AgentRecord[], event: AdminEvent): AgentRecord[] {
  if (event.type === "snapshot") return mergeSnapshot(items, event.agents);
  if (event.type === "offline") return items.map((item) => item.id === event.agent_id || item.agent_id === event.agent_id ? { ...item, online: false } : item);
  if (event.type !== "latest") return items;
  const status = event.data;
  const existing = items.find((item) => item.id === status.agent_id || item.agent_id === status.agent_id);
  return upsertAgent(items, applyStatus(existing ?? createPlaceholderAgent(status), status)).sort(compareAgents);
}

function mergeSnapshot(items: AgentRecord[], snapshot: AgentStatus[]) {
  let next = [...items];
  for (const status of snapshot) {
    const existing = next.find((item) => item.id === status.agent_id || item.agent_id === status.agent_id);
    next = upsertAgent(next, applyStatus(existing ?? createPlaceholderAgent(status), status));
  }
  return next.sort(compareAgents);
}

function applyStatus(agent: AgentRecord, status: AgentStatus): AgentRecord {
  return { ...agent, id: status.id ?? agent.id, agent_id: status.agent_id, name: status.name ?? agent.name, online: status.online, last_seen: status.last_seen, metrics: status.metrics ?? agent.metrics };
}

function createPlaceholderAgent(status: AgentStatus): AgentRecord {
  return { id: status.id ?? status.agent_id, agent_id: status.agent_id, name: status.name ?? status.agent_id, enabled: true, hidden: false, weight: 0, group_name: null, tags: null, remark: null, public_remark: null, token_preview: "Not loaded", online: status.online, last_seen: status.last_seen, metrics: status.metrics, created_at: 0, updated_at: 0 };
}

function upsertAgent(items: AgentRecord[], agent: AgentRecord) {
  const index = items.findIndex((item) => item.id === agent.id || item.agent_id === agent.agent_id);
  if (index === -1) return [...items, agent];
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...agent } : item);
}

function readAgentList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.agents)) return payload.agents;
  if (isRecord(payload) && Array.isArray(payload.items)) return payload.items;
  throw new Error("Invalid agent list response.");
}

function normalizeMutationResult(payload: unknown): AgentMutationResult {
  if (!isRecord(payload)) throw new Error("Invalid agent response.");
  const agentPayload = isRecord(payload.agent) ? payload.agent : payload;
  return { agent: normalizeAgentRecord(agentPayload), token: readString(payload.token) ?? readString(payload.agent_token) ?? "" };
}

function normalizeAgentRecord(payload: unknown): AgentRecord {
  if (!isRecord(payload)) throw new Error("Invalid agent item.");
  const id = readString(payload.id) ?? readString(payload.agent_id);
  const agentId = readString(payload.agent_id) ?? id;
  if (!id || !agentId) throw new Error("Agent item is missing id.");
  return {
    id,
    agent_id: agentId,
    name: readString(payload.name) ?? agentId,
    enabled: readBoolean(payload.enabled, true),
    hidden: readBoolean(payload.hidden, false),
    weight: readNumber(payload.weight) ?? 0,
    group_name: readNullableString(payload.group_name),
    tags: readNullableString(payload.tags),
    remark: readNullableString(payload.remark),
    public_remark: readNullableString(payload.public_remark),
    token_preview: readString(payload.token_preview) ?? "",
    online: readBoolean(payload.online, false),
    last_seen: readNumber(payload.last_seen),
    metrics: isRecord(payload.metrics) ? payload.metrics : undefined,
    created_at: readNumber(payload.created_at) ?? 0,
    updated_at: readNumber(payload.updated_at) ?? 0
  };
}

function defaultNotificationConfig(): NotificationConfig {
  return { enabled: false, webhook_enabled: false, webhook_url: "", telegram_enabled: false, telegram_bot_token: "", telegram_chat_id: "" };
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
  if (isRecord(platform)) {
    for (const key of keys) {
      const value = platform[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

function ratioMetric(agent: AgentRecord, usedKeys: string[], totalKeys: string[]) {
  const used = readMetricAny(agent, usedKeys);
  const total = readMetricAny(agent, totalKeys);
  if (used === null || total === null || total <= 0) return null;
  return used / total * 100;
}

function averageMetricAny(items: AgentRecord[], keys: string[]) {
  const values = items.map((item) => readMetricAny(item, keys)).filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function averageRatioAny(items: AgentRecord[], usedKeys: string[], totalKeys: string[]) {
  const values = items.map((item) => ratioMetric(item, usedKeys, totalKeys)).filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sumMetricAny(items: AgentRecord[], keys: string[]) {
  const values = items.map((item) => readMetricAny(item, keys)).filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function cpuPercent(agent: AgentRecord) { return readMetricAny(agent, ["cpu", "cpu_percent"]); }
function memoryPercent(agent: AgentRecord) { return ratioMetric(agent, MEMORY_USED_KEYS, MEMORY_TOTAL_KEYS); }
function diskPercent(agent: AgentRecord) { return ratioMetric(agent, ["disk_used", "disk_usage"], ["disk_total"]); }
function uploadSpeed(agent: AgentRecord) { return readMetricAny(agent, ["network_up", "net_up", "upload_bps", "tx_bps"]); }
function downloadSpeed(agent: AgentRecord) { return readMetricAny(agent, ["network_down", "net_down", "download_bps", "rx_bps"]); }
function totalUpload(agent: AgentRecord) { return readMetricAny(agent, ["network_total_up", "net_total_up", "total_upload", "tx_total"]); }
function totalDownload(agent: AgentRecord) { return readMetricAny(agent, ["network_total_down", "net_total_down", "total_download", "rx_total"]); }

function formatPercent(value: number | null) { return value === null ? "-" : `${value.toFixed(value >= 10 ? 0 : 1)}%`; }
function formatMetricBytes(agent: AgentRecord, keys: string[]) { return formatBytes(readMetricAny(agent, keys)); }
function formatBytes(value: number | null) {
  if (value === null || value <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) { next /= 1024; index += 1; }
  return `${next.toFixed(next >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
function formatSpeed(value: number | null) { return value === null ? "-" : `${formatBytes(value)}/s`; }
function formatLastSeen(value: number | null) { return value ? new Date(value * 1000).toLocaleString("zh-CN") : "未上报"; }
function formatRelativeAge(value: number | null) {
  if (!value) return "等待首报";
  const seconds = Math.max(0, Math.floor((Date.now() - value * 1000) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
function formatUptime(agent: AgentRecord) {
  const seconds = readMetricAny(agent, ["uptime_sec", "uptime_seconds", "uptime"]);
  if (seconds === null || seconds < 0) return "-";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

function osText(agent: AgentRecord) {
  const os = readStringMetricAny(agent, ["os"]) ?? tagOs(agent) ?? "-";
  const distro = readStringMetricAny(agent, ["distro", "distribution", "os_name"]);
  const arch = readStringMetricAny(agent, ["arch"]) ?? tagArch(agent) ?? "-";
  const system = distro && distro.toLowerCase() !== os.toLowerCase() ? distro : os;
  return `${system} / ${arch}`;
}

function tagLine(agent: AgentRecord) { return [agent.group_name ?? "default", agent.tags].filter(Boolean).join(" / "); }
function tagOs(agent: AgentRecord) { return splitTags(agent.tags).find((tag) => ["linux", "freebsd", "darwin", "macos", "windows"].includes(tag.toLowerCase())) ?? null; }
function tagArch(agent: AgentRecord) { return splitTags(agent.tags).find((tag) => /x86|amd64|arm|aarch|mips|riscv/i.test(tag)) ?? null; }
function splitTags(value: string | null) { return value?.split(",").map((tag) => tag.trim()).filter(Boolean) ?? []; }
function countryCode(agent: AgentRecord) {
  const code = readStringMetricAny(agent, ["country_code", "country", "cf_country"]) ?? splitTags(agent.tags).find((tag) => /^[A-Z]{2}$/i.test(tag));
  return code && /^[A-Z]{2}$/i.test(code) ? code.toUpperCase() : null;
}
function locationText(agent: AgentRecord) {
  const code = countryCode(agent);
  const city = readStringMetricAny(agent, ["city"]);
  const region = readStringMetricAny(agent, ["region", "region_code"]);
  const colo = readStringMetricAny(agent, ["colo", "datacenter"]);
  const place = [city, region].filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index).join(" / ");
  return [code, place, colo].filter(Boolean).join(" · ") || "-";
}
function flagForAgent(agent: AgentRecord) {
  const code = countryCode(agent);
  if (!code) return "🌐";
  return [...code].map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65)).join("");
}
function buildInstallCommand(token: string) {
  const origin = window.location.origin;
  return `curl -fsSL ${origin}/install.sh | sh -s -- --endpoint '${origin}' --token '${token.replaceAll("'", "'\"'\"'")}' --profile full --interval 3 --installer-url '${origin}/install.sh'`;
}
function emptyToNull(value: string) { const next = value.trim(); return next ? next : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function readString(value: unknown) { return typeof value === "string" && value.length > 0 ? value : undefined; }
function readNullableString(value: unknown) { return typeof value === "string" && value.length > 0 ? value : null; }
function readBoolean(value: unknown, fallback: boolean) { return typeof value === "boolean" ? value : fallback; }
function readNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function toErrorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
