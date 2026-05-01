export type ApiResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace;
}

export interface InitStatus {
  schemaReady: boolean;
  initialized: boolean;
  initializedAt: string | null;
}

export interface UserDto {
  id: string;
  username: string;
}

export interface AgentDto {
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
  last_seen: number;
  metrics?: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export type HubSocketRole = "agent" | "admin";

export interface HubSocketAttachment {
  role: HubSocketRole;
  connectedAt: string;
  agentId?: string;
  adminId?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  colo?: string;
}
