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
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo, Role, Table } from "./types.ts";
import { buildTokenMap } from "./auth.ts";
import { createPromotionRouter } from "./rest-promotion.ts";
import { registerDemoteEntry } from "./tools/demote-entry.ts";
import { registerPromoteShared } from "./tools/promote-shared.ts";
import type { ToolDeps } from "./tools/index.ts";
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

// ---------------------------------------------------------------------------
// Demote gates (cross-model review finding on PR #235): the REST /api/v1/demote
// and MCP demote_entry gates used to hard-code `role === "admin"`, so ob-admin
// could promote/archive but not REVERSE a bad promotion -- contradicting the
// break-glass admin-equivalent intent. These tests fail on that behavior.
// ---------------------------------------------------------------------------

interface SequencePool {
  calls: Array<{ sql: string; params: unknown[] }>;
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

function createSequencePool(
  rowSets: Array<Record<string, unknown>[]>,
): SequencePool {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const rows = rowSets.shift() ?? [];
      return { rows, rowCount: rows.length };
    },
  };
}

function buildRestApp(auth: AuthInfo, pool: SequencePool) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).auth = auth;
    next();
  });
  app.use(
    "/api/v1",
    createPromotionRouter({ pool: pool as any, embedFn: (async () => null) as any }),
  );
  return app;
}

async function restPost(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    // Port 0: OS-assigned ephemeral port, immune to EADDRINUSE flake under
    // parallel test runs.
    const server = app.listen(0, async () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Expected a TCP address from app.listen(0)"));
        return;
      }
      try {
        const resp = await fetch(`http://localhost:${address.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        resolve({ status: resp.status, json: await resp.json() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

async function setupToolClient(
  register: (server: McpServer, deps: ToolDeps) => void,
  pool: SequencePool,
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  register(server, {
    pool: pool as any,
    embedFn: (async () => Array(768).fill(0.1)) as any,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) =>
    originalSend(message, { ...options, authInfo: auth });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

const DEMOTE_ID = "550e8400-e29b-41d4-a716-446655440168";

function demoteRowSets(): Array<Record<string, unknown>[]> {
  return [
    [
      {
        id: DEMOTE_ID,
        namespace: "shared-kb",
        promoted_from: { source_id: "src-1", source_namespace: "bilby" },
      },
    ],
    [{ id: DEMOTE_ID }],
  ];
}

describe("#168 demote gates accept ob-admin (parity with admin)", () => {
  test("REST /api/v1/demote: ob-admin is allowed (200, demoted), same as admin", async () => {
    for (const role of ["admin", "ob-admin"] as Role[]) {
      const pool = createSequencePool(demoteRowSets());
      const app = buildRestApp(tokenAuth(role), pool);
      const { status, json } = await restPost(app, "/api/v1/demote", {
        table: "thoughts",
        id: DEMOTE_ID,
      });
      expect(status).toBe(200);
      expect(json.status).toBe("demoted");
    }
  });

  test("REST /api/v1/demote: agent/discord/readonly/promoter are rejected with 403", async () => {
    for (const role of ["agent", "discord", "readonly", "promoter"] as Role[]) {
      const pool = createSequencePool(demoteRowSets());
      const app = buildRestApp(tokenAuth(role), pool);
      const { status } = await restPost(app, "/api/v1/demote", {
        table: "thoughts",
        id: DEMOTE_ID,
      });
      expect(status).toBe(403);
      // gate fires before any DB access
      expect(pool.calls.length).toBe(0);
    }
  });

  test("MCP demote_entry: ob-admin is allowed (demoted), same as admin", async () => {
    for (const role of ["admin", "ob-admin"] as Role[]) {
      const pool = createSequencePool(demoteRowSets());
      const { client, cleanup } = await setupToolClient(
        registerDemoteEntry,
        pool,
        tokenAuth(role),
      );
      try {
        const result = await client.callTool({
          name: "demote_entry",
          arguments: { table: "thoughts", id: DEMOTE_ID },
        });
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.status).toBe("demoted");
        expect(parsed.archived_id).toBe(DEMOTE_ID);
      } finally {
        await cleanup();
      }
    }
  });

  test("MCP demote_entry: agent/discord/readonly/promoter are rejected before any DB access", async () => {
    for (const role of ["agent", "discord", "readonly", "promoter"] as Role[]) {
      const pool = createSequencePool(demoteRowSets());
      const { client, cleanup } = await setupToolClient(
        registerDemoteEntry,
        pool,
        tokenAuth(role),
      );
      try {
        const result = await client.callTool({
          name: "demote_entry",
          arguments: { table: "thoughts", id: DEMOTE_ID },
        });
        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toContain("Permission denied");
        expect(pool.calls.length).toBe(0);
      } finally {
        await cleanup();
      }
    }
  });
});

describe("#168 promote_shared entry gate accepts ob-admin (parity with admin)", () => {
  // With an empty pool, an authorized identity reaches the source lookup and
  // gets "Source entry not found" -- proving it passed the auth gate -- while an
  // unauthorized identity is stopped at the gate with "Permission denied".
  test("ob-admin passes the promote_shared auth gate exactly like admin", async () => {
    for (const role of ["admin", "ob-admin"] as Role[]) {
      const pool = createSequencePool([[]]);
      const { client, cleanup } = await setupToolClient(
        registerPromoteShared,
        pool,
        tokenAuth(role),
      );
      try {
        const result = await client.callTool({
          name: "promote_shared",
          arguments: { table: "thoughts", id: DEMOTE_ID },
        });
        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toBe(
          "Source entry not found or archived",
        );
      } finally {
        await cleanup();
      }
    }
  });

  test("agent/discord/readonly are stopped at the promote_shared auth gate", async () => {
    for (const role of ["agent", "discord", "readonly"] as Role[]) {
      const pool = createSequencePool([[]]);
      const { client, cleanup } = await setupToolClient(
        registerPromoteShared,
        pool,
        tokenAuth(role),
      );
      try {
        const result = await client.callTool({
          name: "promote_shared",
          arguments: { table: "thoughts", id: DEMOTE_ID },
        });
        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toContain("Permission denied");
        expect(pool.calls.length).toBe(0);
      } finally {
        await cleanup();
      }
    }
  });
});
