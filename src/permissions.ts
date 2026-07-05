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
  // Break-glass server-side admin identity (#168). Full RWD on every table --
  // identical to `admin`. This is the honest name for what was historically the
  // misnamed, 100%-unused `n8n` role; it is for HUMAN server-side surgery
  // (deletions, manual user promotions), not for n8n.io automations.
  "ob-admin": {
    thoughts: RWD,
    decisions: RWD,
    relationships: RWD,
    projects: RWD,
    sessions: RWD,
  },
  // Promotion service identity (#147). Reads source entries and writes/archives
  // into the shared namespace with provenance. RWD on curation tables so
  // promote + demote/archive work; RO on projects (promotion never authors
  // projects). Namespace authority (who can write shared-kb) is enforced
  // separately in namespace-policy.isPromoterIdentity.
  promoter: {
    thoughts: RWD,
    decisions: RWD,
    relationships: RWD,
    projects: RO,
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
