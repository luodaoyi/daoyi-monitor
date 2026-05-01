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

export interface SiteConfig {
  site_name: string;
  site_description: string;
  agent_endpoint: string;
  agent_profile: string;
  agent_interval_sec: number;
  agent_channel: string;
  agent_install_dir: string;
  api_key: string;
  auto_discovery_key: string;
  geoip_enabled: boolean;
  geoip_provider: string;
  disable_password_login: boolean;
  oidc_enabled: boolean;
  oidc_provider: string;
  oidc_issuer: string;
  oidc_client_id: string;
  oidc_client_secret: string;
  custom_head: string;
  custom_body: string;
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
