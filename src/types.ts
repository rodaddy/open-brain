export type Role = "admin" | "agent" | "discord" | "n8n" | "readonly";
export type Table =
  | "thoughts"
  | "decisions"
  | "relationships"
  | "projects"
  | "sessions";
// Keep in sync with CHECK (relation IN (...)) in 010_entity_links.sql
export type LinkRelation =
  | "artifact"
  | "depends_on"
  | "supersedes"
  | "caused_by"
  | "same_lane"
  | "adjacent"
  | "mentions"
  | "implemented_by"
  | "blocked_by"
  | "decided_by"
  | "relates_to"
  | "contradicts"
  | "duplicates";
export type Tier = "hot" | "warm" | "cold";
export type Permission = "read" | "write" | "delete";

export interface AuthInfo {
  role: Role;
  clientId: string;
  tokenClientId?: string;
  agentId?: string;
  namespaceSource?: "token" | "header";
  headerRole?: string;
}

export interface PoolHealth {
  connected: boolean;
  total: number;
  idle: number;
  waiting: number;
}

export interface HealthStatus {
  status: "healthy" | "degraded";
  database: PoolHealth;
  litellm: { connected: boolean };
  timestamp: string;
}
