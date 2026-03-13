import type { Role, Table, Permission } from "./types.ts";

const RW: Set<Permission> = new Set(["read", "write"]);
const RO: Set<Permission> = new Set(["read"]);
const WO: Set<Permission> = new Set(["write"]);
const NONE: Set<Permission> = new Set();

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
