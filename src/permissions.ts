import type { Role, Table, Permission } from "./types.ts";

const RWD = Object.freeze(new Set<Permission>(["read", "write", "delete"]));
const RW = Object.freeze(new Set<Permission>(["read", "write"]));
const RO = Object.freeze(new Set<Permission>(["read"]));
const WO = Object.freeze(new Set<Permission>(["write"]));
const NONE = Object.freeze(new Set<Permission>());

export const PERMISSIONS: Record<Role, Record<Table, Set<Permission>>> = {
  admin: {
    thoughts: RWD,
    decisions: RWD,
    relationships: RWD,
    projects: RWD,
    sessions: RWD,
  },
  agent: {
    thoughts: RW,
    decisions: RW,
    relationships: RW,
    projects: RO,
    sessions: RW,
  },
  discord: {
    thoughts: WO,
    decisions: NONE,
    relationships: NONE,
    projects: NONE,
    sessions: NONE,
  },
  n8n: {
    thoughts: RWD,
    decisions: RWD,
    relationships: RWD,
    projects: RWD,
    sessions: RWD,
  },
  readonly: {
    thoughts: RO,
    decisions: RO,
    relationships: RO,
    projects: RO,
    sessions: RO,
  },
};

export function canRead(role: Role, table: Table): boolean {
  return PERMISSIONS[role][table].has("read");
}

export function canWrite(role: Role, table: Table): boolean {
  return PERMISSIONS[role][table].has("write");
}

export function canDelete(role: Role, table: Table): boolean {
  return PERMISSIONS[role][table].has("delete");
}
