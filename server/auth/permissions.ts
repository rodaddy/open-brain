/**
 * Role-to-resource permission boundary.
 *
 * Design authority: `docs/decisions/admin-and-promoter-identities.md` fixes the
 * promoter denial set and the full `ob-admin` break-glass surface.
 */
import type { Role } from "../config.ts";
import type { Permission, ResourceTable } from "./types.ts";

const RWD = new Set<Permission>(["read", "write", "delete"]);
const RW = new Set<Permission>(["read", "write"]);
const RO = new Set<Permission>(["read"]);
const WO = new Set<Permission>(["write"]);
const NONE = new Set<Permission>();

type TablePermissions = Readonly<Record<ResourceTable, ReadonlySet<Permission>>>;

const FULL_ACCESS: TablePermissions = {
  thoughts: RWD,
  decisions: RWD,
  relationships: RWD,
  projects: RWD,
  sessions: RWD,
};

export const PERMISSIONS: Readonly<Record<Role, TablePermissions>> = {
  admin: FULL_ACCESS,
  "ob-admin": FULL_ACCESS,
  promoter: {
    thoughts: RWD,
    decisions: RWD,
    relationships: RWD,
    projects: RO,
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
  readonly: {
    thoughts: RO,
    decisions: RO,
    relationships: RO,
    projects: RO,
    sessions: RO,
  },
};

/** @returns Whether the role may read the resource table. */
export function canRead(role: Role, table: ResourceTable): boolean {
  return PERMISSIONS[role][table].has("read");
}

/** @returns Whether the role may write the resource table. */
export function canWrite(role: Role, table: ResourceTable): boolean {
  return PERMISSIONS[role][table].has("write");
}

/** @returns Whether the role may delete from the resource table. */
export function canDelete(role: Role, table: ResourceTable): boolean {
  return PERMISSIONS[role][table].has("delete");
}
