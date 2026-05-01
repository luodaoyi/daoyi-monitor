import { get, writable } from "svelte/store";
import { apiDelete, apiGet, apiPost } from "../api/client";
import type { AdminEvent, AgentCreateInput, AgentMutationResult, AgentRecord, AgentStatus } from "../types";

export const agents = writable<AgentRecord[]>([]);
export const agentsLoading = writable(false);

export async function loadAgents(): Promise<AgentRecord[]> {
  agentsLoading.set(true);
  try {
    const payload = await apiGet<unknown>("/api/agents");
    const items = readAgentList(payload).map((item) => normalizeAgentRecord(item));
    agents.set(sortAgents(items));
    return items;
  } finally {
    agentsLoading.set(false);
  }
}

export async function loadPublicAgents(): Promise<AgentRecord[]> {
  agentsLoading.set(true);
  try {
    const payload = await apiGet<unknown>("/api/public/agents");
    const items = readAgentList(payload).map((item) => normalizeAgentRecord(item));
    agents.set(sortAgents(items));
    return items;
  } finally {
    agentsLoading.set(false);
  }
}

export function clearAgents(): void {
  agents.set([]);
}

export async function createAgent(input: AgentCreateInput): Promise<AgentMutationResult> {
  const result = normalizeMutationResult(await apiPost<unknown>("/api/agents", input));
  agents.update((items) => sortAgents(upsertAgent(items, result.agent)));
  return result;
}

export async function deleteAgent(id: string, confirm: string): Promise<void> {
  await apiDelete<void>(`/api/agents/${encodeURIComponent(id)}`, { confirm });
  agents.update((items) => items.filter((item) => item.id !== id && item.agent_id !== id));
}

export async function rotateAgentToken(id: string): Promise<AgentMutationResult> {
  const result = normalizeMutationResult(
    await apiPost<unknown>(`/api/agents/${encodeURIComponent(id)}/token/rotate`)
  );
  agents.update((items) => sortAgents(upsertAgent(items, result.agent)));
  return result;
}

export function getAgentStatus(agentId: string): AgentRecord | undefined {
  return get(agents).find((item) => item.agent_id === agentId || item.id === agentId);
}

export function applyRealtimeEvent(event: AdminEvent): void {
  if (event.type === "snapshot") {
    agents.update((items) => mergeSnapshot(items, event.agents));
    return;
  }

  if (event.type !== "latest" && event.type !== "offline") {
    return;
  }

  agents.update((items) => {
    if (event.type === "offline") {
      return items.map((item) =>
        item.agent_id === event.agent_id || item.id === event.agent_id
          ? { ...item, online: false }
          : item
      );
    }

    const next = event.data;
    const existing = items.find((item) => item.agent_id === next.agent_id || item.id === next.agent_id);
    return sortAgents(upsertAgent(items, applyStatus(existing ?? createPlaceholderAgent(next), next)));
  });
}

function mergeSnapshot(items: AgentRecord[], snapshot: AgentStatus[]): AgentRecord[] {
  const merged = [...items];

  for (const status of snapshot) {
    const placeholder = createPlaceholderAgent(status);
    const next = applyStatus(placeholder, status);
    const index = merged.findIndex(
      (item) => item.agent_id === next.agent_id || item.id === next.agent_id || item.id === next.id
    );

    if (index === -1) {
      merged.push(next);
      continue;
    }

    merged[index] = applyStatus(merged[index], status);
  }

  return sortAgents(merged);
}

function upsertAgent(items: AgentRecord[], agent: AgentRecord): AgentRecord[] {
  const index = items.findIndex(
    (item) => item.id === agent.id || item.agent_id === agent.agent_id || item.id === agent.agent_id
  );

  if (index === -1) {
    return [...items, agent];
  }

  return items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...agent } : item));
}

function applyStatus(agent: AgentRecord, status: AgentStatus): AgentRecord {
  return {
    ...agent,
    id: status.id ?? agent.id,
    agent_id: status.agent_id,
    name: status.name ?? agent.name,
    online: status.online,
    last_seen: status.last_seen,
    metrics: status.metrics ?? agent.metrics
  };
}

function normalizeMutationResult(payload: unknown): AgentMutationResult {
  if (!isRecord(payload)) {
    throw new Error("Invalid agent response.");
  }

  const token = readString(payload.token) ?? readString(payload.agent_token) ?? "";
  const agentPayload = isRecord(payload.agent) ? payload.agent : payload;

  return {
    agent: normalizeAgentRecord(agentPayload),
    token
  };
}

function readAgentList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (isRecord(payload) && Array.isArray(payload.agents)) {
    return payload.agents;
  }

  if (isRecord(payload) && Array.isArray(payload.items)) {
    return payload.items;
  }

  throw new Error("Invalid agent list response.");
}

function normalizeAgentRecord(payload: unknown): AgentRecord {
  if (!isRecord(payload)) {
    throw new Error("Invalid agent item.");
  }

  const id = readString(payload.id) ?? readString(payload.agent_id);
  const agentId = readString(payload.agent_id) ?? id;

  if (!id || !agentId) {
    throw new Error("Agent item is missing id.");
  }

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
    token_preview: readString(payload.token_preview) ?? "Only shown once",
    online: readBoolean(payload.online, false),
    last_seen: readNumber(payload.last_seen),
    metrics: isRecord(payload.metrics) ? payload.metrics : undefined,
    created_at: readNumber(payload.created_at) ?? 0,
    updated_at: readNumber(payload.updated_at) ?? 0
  };
}

function createPlaceholderAgent(status: AgentStatus): AgentRecord {
  const id = status.id ?? status.agent_id;
  return {
    id,
    agent_id: status.agent_id,
    name: status.name ?? status.agent_id,
    enabled: true,
    hidden: false,
    weight: 0,
    group_name: null,
    tags: null,
    remark: null,
    public_remark: null,
    token_preview: "Not loaded",
    online: status.online,
    last_seen: status.last_seen,
    metrics: status.metrics,
    created_at: 0,
    updated_at: 0
  };
}

function sortAgents(items: AgentRecord[]): AgentRecord[] {
  return [...items].sort((left, right) => {
    if (left.online !== right.online) {
      return Number(right.online) - Number(left.online);
    }

    if (left.hidden !== right.hidden) {
      return Number(left.hidden) - Number(right.hidden);
    }

    return left.name.localeCompare(right.name, "zh-Hans-CN");
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
