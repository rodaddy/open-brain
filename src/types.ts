export type Role = "admin" | "agent" | "discord" | "n8n" | "readonly";
export type Table =
  | "thoughts"
  | "decisions"
  | "relationships"
  | "projects"
  | "sessions";
export type Tier = "hot" | "warm" | "cold";
export type Permission = "read" | "write" | "delete";

export interface AuthInfo {
  role: Role;
  clientId: string;
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
