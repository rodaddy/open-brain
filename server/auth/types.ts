/**
 * Authentication domain types.
 *
 * Design authority: `docs/decisions/admin-and-promoter-identities.md` separates
 * break-glass administration from promotion automation; `docs/decisions/
 * privilege-isolation-closed-brain.md` makes server-side isolation mandatory.
 */
import type { Role } from "../config.ts";

export interface AuthIdentity {
  readonly role: Role;
  readonly clientId: string;
  readonly tokenClientId: string;
  readonly namespaceSource: "token" | "delegated";
}

export type Permission = "read" | "write" | "delete";
export type ResourceTable =
  | "thoughts"
  | "decisions"
  | "relationships"
  | "projects"
  | "sessions";
