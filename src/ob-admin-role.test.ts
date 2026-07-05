// Regression test for #168: the `n8n` role was renamed to `ob-admin` (the
// honest name for the break-glass, server-side admin identity). This is a
// security-boundary change, so this suite proves three things:
//
//   1. `ob-admin` passes EVERY privileged gate that `admin` passes -- enumerated
//      gate-by-gate, not spot-checked, so a future refactor that forgets one
//      gate fails here.
//   2. The old `n8n` name is now UNKNOWN everywhere it used to be honored
//      (role-env-key load, per-user `role:token` prefix). A token that was
//      mapped to `n8n` is rejected/dropped.
//   3. Non-admin roles (agent, discord, readonly, promoter) are unaffected by
//      the rename.
//
// The old behavior (a live `n8n` role) would fail cases (2): buildTokenMap used
// to accept AUTH_TOKEN_N8N and `n8n:` per-user prefixes.

import { describe, expect, test } from "bun:test";
import type { AuthInfo, Role, Table } from "./types.ts";
import { buildTokenMap } from "./auth.ts";
import { canRead, canWrite, canDelete, PERMISSIONS } from "./permissions.ts";
import {
  canWriteNamespace,
  writableNamespaces,
  appendWriteNamespacePredicate,
  isPromoterIdentity,
} from "./namespace-policy.ts";
import {
  readableNamespaces,
  canReadNamespace,
  namespaceFilterFor,
} from "./read-policy.ts";
import { shouldRejectLegacySharedWrite } from "./shared-namespace.ts";

const ALL_TABLES: Table[] = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
];

function tokenAuth(role: Role): AuthInfo {
  return { role, clientId: role, tokenClientId: role, namespaceSource: "token" };
}

const adminAuth = tokenAuth("admin");
const obAdminAuth = tokenAuth("ob-admin");

describe("#168 ob-admin parity with admin -- every privileged gate", () => {
  test("PERMISSIONS matrix: ob-admin is byte-identical to admin (full RWD)", () => {
    for (const table of ALL_TABLES) {
      expect(canRead("ob-admin", table)).toBe(canRead("admin", table));
      expect(canWrite("ob-admin", table)).toBe(canWrite("admin", table));
      expect(canDelete("ob-admin", table)).toBe(canDelete("admin", table));
      // and absolutely full RWD
      expect(canRead("ob-admin", table)).toBe(true);
      expect(canWrite("ob-admin", table)).toBe(true);
      expect(canDelete("ob-admin", table)).toBe(true);
    }
    expect(PERMISSIONS["ob-admin"]).toEqual(PERMISSIONS.admin);
  });

  test("gate: canWriteNamespace to an arbitrary namespace (admin-like broad write)", () => {
    expect(canWriteNamespace(obAdminAuth, "some-other-ns").allowed).toBe(
      canWriteNamespace(adminAuth, "some-other-ns").allowed,
    );
    expect(canWriteNamespace(obAdminAuth, "some-other-ns").allowed).toBe(true);
  });

  test("gate: writableNamespaces is unrestricted (undefined) like admin", () => {
    expect(writableNamespaces(obAdminAuth)).toBeUndefined();
    expect(writableNamespaces(obAdminAuth)).toEqual(
      writableNamespaces(adminAuth),
    );
  });

  test("gate: readableNamespaces is unrestricted (undefined) like admin", () => {
    expect(readableNamespaces(obAdminAuth)).toBeUndefined();
    expect(readableNamespaces(obAdminAuth)).toEqual(
      readableNamespaces(adminAuth),
    );
  });

  test('gate: "all" keyword cross-namespace read allowed for token-sourced ob-admin', () => {
    expect(canReadNamespace(obAdminAuth, "all")).toBe(true);
    expect(canReadNamespace(obAdminAuth, "all")).toBe(
      canReadNamespace(adminAuth, "all"),
    );
    expect(namespaceFilterFor(obAdminAuth, "all")).toBeUndefined();
    expect(namespaceFilterFor(obAdminAuth, "all")).toEqual(
      namespaceFilterFor(adminAuth, "all"),
    );
  });

  test("gate: legacy shared namespace ('collab') read is allowed for ob-admin", () => {
    expect(canReadNamespace(obAdminAuth, "collab")).toBe(true);
    expect(canReadNamespace(obAdminAuth, "collab")).toBe(
      canReadNamespace(adminAuth, "collab"),
    );
  });

  test("gate: legacy shared namespace write is NOT rejected for ob-admin", () => {
    expect(shouldRejectLegacySharedWrite(obAdminAuth, "collab")).toBe(false);
    expect(shouldRejectLegacySharedWrite(obAdminAuth, "collab")).toBe(
      shouldRejectLegacySharedWrite(adminAuth, "collab"),
    );
  });

  test("gate: appendWriteNamespacePredicate excludes shared-kb for bare ob-admin (matches admin)", () => {
    const obParams: unknown[] = [];
    const adminParams: unknown[] = [];
    const obPred = appendWriteNamespacePredicate(obAdminAuth, obParams);
    const adminPred = appendWriteNamespacePredicate(adminAuth, adminParams);
    expect(obPred).toBe(adminPred);
    // bare admin-like identity is broad but excludes shared-kb (promoter-only)
    expect(obPred).toContain("<>");
    expect(obParams).toEqual(adminParams);
  });

  test("gate: X-Namespace delegation is permitted for ob-admin (rejected for non-admin-like)", () => {
    // authMiddleware: only admin/ob-admin may delegate via X-Namespace.
    const map = buildTokenMap({
      AUTH_TOKEN_OB_ADMIN: "obadmin-tok",
      AUTH_TOKEN_AGENT: "agent-tok",
    });
    const mw = require("./auth.ts").authMiddleware(map) as (
      req: any,
      res: any,
      next: () => void,
    ) => void;

    function run(token: string) {
      const req: any = {
        headers: {
          authorization: `Bearer ${token}`,
          "x-namespace": "delegated-ns",
        },
      };
      let status = 0;
      let nexted = false;
      const res: any = {
        status(code: number) {
          status = code;
          return { json() {} };
        },
      };
      mw(req, res, () => {
        nexted = true;
      });
      return { status, nexted, auth: req.auth };
    }

    const obResult = run("obadmin-tok");
    expect(obResult.nexted).toBe(true);
    expect(obResult.auth.clientId).toBe("delegated-ns");
    expect(obResult.auth.namespaceSource).toBe("header");

    // agent (non-admin-like) is blocked from delegating -- unaffected by rename
    const agentResult = run("agent-tok");
    expect(agentResult.nexted).toBe(false);
    expect(agentResult.status).toBe(403);
  });

  test("gate: legacy promoter-clientId-on-ob-admin is still a promoter identity", () => {
    // Backward-compat path preserved: admin/ob-admin + promoter clientId.
    const legacyPromoter: AuthInfo = {
      role: "ob-admin",
      clientId: "openbrain-promoter",
      tokenClientId: "openbrain-promoter",
    };
    expect(isPromoterIdentity(legacyPromoter)).toBe(true);
  });
});

describe("#168 the old `n8n` role name is now UNKNOWN (clean break, no alias)", () => {
  test("AUTH_TOKEN_N8N is not a recognized role-env key (token dropped)", () => {
    const map = buildTokenMap({ AUTH_TOKEN_N8N: "old-n8n-secret" });
    // No role-env key matches AUTH_TOKEN_N8N anymore, so the token is not loaded.
    expect(map.has("old-n8n-secret")).toBe(false);
    expect(map.size).toBe(0);
  });

  test("per-user token with `n8n:` role prefix is rejected as an invalid role", () => {
    const map = buildTokenMap({
      AUTH_TOKEN_USER_LEGACY: "n8n:legacy-user-secret",
    });
    // `n8n` is no longer in VALID_ROLES -> the whole entry is skipped.
    expect(map.has("legacy-user-secret")).toBe(false);
    expect(map.size).toBe(0);
  });

  test("the new AUTH_TOKEN_OB_ADMIN env key loads as role ob-admin", () => {
    const map = buildTokenMap({ AUTH_TOKEN_OB_ADMIN: "obadmin-secret" });
    expect(map.get("obadmin-secret")).toEqual({
      role: "ob-admin",
      clientId: "ob-admin",
    });
  });
});

describe("#168 non-admin roles are unaffected by the rename", () => {
  test("agent/discord/readonly do not get the admin-like 'all' cross-namespace read", () => {
    // promoter is intentionally broad-read (#147) so it is excluded here; the
    // point is that the rename did not accidentally widen the scoped roles.
    for (const role of ["agent", "discord", "readonly"] as Role[]) {
      const auth = tokenAuth(role);
      expect(canReadNamespace(auth, "all")).toBe(false);
    }
  });

  test("agent writable namespaces remain scoped to own clientId", () => {
    const agent: AuthInfo = { role: "agent", clientId: "some-agent" };
    expect(writableNamespaces(agent)).toEqual(["some-agent"]);
  });

  test("readonly still cannot write anywhere", () => {
    const readonly: AuthInfo = { role: "readonly", clientId: "ro" };
    expect(canWriteNamespace(readonly, "ro").allowed).toBe(false);
  });
});
