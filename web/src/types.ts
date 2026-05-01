export type InitStatus = {
  schemaReady: boolean;
  initialized: boolean;
  initializedAt: string | null;
};

export type User = {
  id: string;
  username: string;
};

export type AgentRecord = {
  id: string;
  agent_id: string;
  name: string;
  enabled: boolean;
  hidden: boolean;
  weight: number;
  group_name: string | null;
  tags: string | null;
  remark: string | null;
  public_remark: string | null;
  token_preview: string;
  online: boolean;
  last_seen: number | null;
  metrics?: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type AgentCreateInput = {
  name: string;
  enabled: boolean;
  hidden: boolean;
  weight: number;
  group_name?: string | null;
  tags?: string | null;
  remark?: string | null;
  public_remark?: string | null;
};

export type AgentMutationResult = {
  agent: AgentRecord;
  token: string;
};

export type AgentStatus = {
  id?: string;
  agent_id: string;
  name?: string;
  online: boolean;
  last_seen: number | null;
  metrics?: Record<string, unknown>;
};

export type AdminEvent =
  | { type: "snapshot"; agents: AgentStatus[] }
  | { type: "latest"; data: AgentStatus }
  | { type: "offline"; agent_id: string };

export type NotificationConfig = {
  enabled: boolean;
  webhook_enabled: boolean;
  webhook_url: string | null;
  telegram_enabled: boolean;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
};
