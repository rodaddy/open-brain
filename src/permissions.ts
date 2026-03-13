import type { Role, Table, Permission } from "./types.ts";

// Stub: TDD RED phase -- will be properly implemented after tests confirm failure
export const PERMISSIONS: Record<Role, Record<Table, Set<Permission>>> = {
  admin: {
    thoughts: new Set(),
    decisions: new Set(),
    relationships: new Set(),
    projects: new Set(),
    sessions: new Set(),
  },
  agent: {
    thoughts: new Set(),
    decisions: new Set(),
    relationships: new Set(),
    projects: new Set(),
    sessions: new Set(),
  },
  discord: {
    thoughts: new Set(),
    decisions: new Set(),
    relationships: new Set(),
    projects: new Set(),
    sessions: new Set(),
  },
  n8n: {
    thoughts: new Set(),
    decisions: new Set(),
    relationships: new Set(),
    projects: new Set(),
    sessions: new Set(),
  },
  readonly: {
    thoughts: new Set(),
    decisions: new Set(),
    relationships: new Set(),
    projects: new Set(),
    sessions: new Set(),
  },
};

export function canRead(_role: Role, _table: Table): boolean {
  return false;
}

export function canWrite(_role: Role, _table: Table): boolean {
  return false;
}
