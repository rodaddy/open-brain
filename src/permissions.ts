import type { Role, Table, Permission } from "./types.ts";

const RW = Object.freeze(new Set<Permission>(["read", "write"]));
const RO = Object.freeze(new Set<Permission>(["read"]));
const WO = Object.freeze(new Set<Permission>(["write"]));
const NONE = Object.freeze(new Set<Permission>());

export const PERMISSIONS: Record<Role, Record<Table, Set<Permission>>> = {
  admin: {
    thoughts: RW,
    decisions: RW,
    relationships: RW,
    projects: RW,
    sessions: RW,
  },
  agent: {
    thoughts: RW,
    decisions: RW,
    relationships: RO,
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
    thoughts: RW,
    decisions: RW,
    relationships: RW,
    projects: RW,
    sessions: RW,
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
