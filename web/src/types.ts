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
  | { type: "offline"; agent_id: string }
  | { type: "connected"; role: string; connectedAt: string }
  | { type: "agent_connected"; agentId: string | null; at: string }
  | { type: "peer_disconnected"; role: string; agentId: string | null; adminId: string | null; at: string }
  | { type: "peer_error"; role: string; agentId: string | null; adminId: string | null; error: string; at: string }
  | { type: "ack"; event?: string; at: string }
  | { type: "pong"; at: string };

export type NotificationConfig = {
  enabled: boolean;
  template: string;
  offline_enabled: boolean;
  offline_grace_sec: number;
  load_enabled: boolean;
  load_threshold: number;
  webhook_enabled: boolean;
  webhook_url: string | null;
  telegram_enabled: boolean;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
};

export type SiteConfig = {
  site_name: string;
  site_description: string;
  agent_endpoint: string;
  agent_profile: string;
  agent_interval_sec: number;
  agent_channel: string;
  agent_install_dir: string;
  agent_config_file: string;
  custom_head: string;
  custom_body: string;
};
