import { describe, it, expect } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createPromotionRouter } from "./rest-promotion.ts";
import type { AuthInfo } from "./types.ts";

function createSequencePool(rowSets: Array<Record<string, unknown>[]>) {
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

function buildApp(auth: AuthInfo, pool: ReturnType<typeof createSequencePool>) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).auth = auth;
    next();
  });
  app.use(
    "/api/v1",
    createPromotionRouter({
      pool: pool as any,
      embedFn: (async () => null) as any,
    }),
  );
  return app;
}

async function req(
  app: express.Express,
  method: "get" | "post",
  path: string,
  body?: unknown,
) {
  const opts: RequestInit = { method: method.toUpperCase() };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }

  let server: ReturnType<typeof app.listen>;
  const port = 20000 + Math.floor(Math.random() * 1000);

  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    server = app.listen(port, async () => {
      try {
        const resp = await fetch(`http://localhost:${port}${path}`, opts);
        const json = await resp.json();
        resolve({ status: resp.status, json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("promotion REST API", () => {
  it("returns 400 for invalid promote id", async () => {
    const pool = createSequencePool([]);
    const app = buildApp({ role: "admin", clientId: "rico" }, pool);

    const { status } = await req(app, "post", "/api/v1/promote", {
      table: "thoughts",
      id: "not-a-uuid",
    });

    expect(status).toBe(400);
    expect(pool.calls.length).toBe(0);
  });

  it("returns duplicate when a project name already exists in the target namespace", async () => {
    const sourceId = "123e4567-e89b-12d3-a456-426614174000";
    const pool = createSequencePool([
      [
        {
          id: sourceId,
          namespace: "bilby",
          created_by: "bilby",
          name: "Open Brain",
          content_hash: null,
        },
      ],
      [{ id: "123e4567-e89b-12d3-a456-426614174001", archived_at: null }],
    ]);
    const app = buildApp({ role: "admin", clientId: "rico" }, pool);

    const { status, json } = await req(app, "post", "/api/v1/promote", {
      table: "projects",
      id: sourceId,
      target_namespace: "collab",
    });

    expect(status).toBe(409);
    expect(json.status).toBe("duplicate");
    expect(json.existing_id).toBe("123e4567-e89b-12d3-a456-426614174001");
    expect(pool.calls[1]!.sql).toContain("name = $2");
  });

  it("returns a dry-run report without inserting", async () => {
    const sourceId = "123e4567-e89b-12d3-a456-426614174002";
    const pool = createSequencePool([
      [
        {
          id: sourceId,
          namespace: "collab",
          created_by: "legacy-agent",
          content: "legacy shared knowledge",
          content_hash: "hash-dry-run",
          extracted_metadata: {
            discord_server_id: "server-1",
            discord_channel_id: "channel-1",
            repo: "rico/open-brain",
          },
        },
      ],
      [],
    ]);
    const app = buildApp({ role: "admin", clientId: "openbrain-promoter" }, pool);

    const { status, json } = await req(app, "post", "/api/v1/promote", {
      table: "thoughts",
      id: sourceId,
      target_namespace: "shared-kb",
      reason: "verified legacy collab knowledge",
      dry_run: true,
      promotion_actor: "spoofed-actor",
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      status: "dry_run",
      dry_run: true,
      would_insert: true,
      source_id: sourceId,
      source_namespace: "collab",
      target_namespace: "shared-kb",
      provenance: {
        source_physical_namespace: "collab",
        source_table: "thoughts",
        source_id: sourceId,
        source_identity: "legacy-agent",
        source_repo: "rico/open-brain",
        target_namespace: "shared-kb",
        promoted_by: "openbrain-promoter",
        promotion_reason: "verified legacy collab knowledge",
      },
      backoff: {
        retryable: true,
        suggested_delay_ms: 250,
      },
    });
    expect(json.provenance.source_discord).toEqual({
      server_id: "server-1",
      channel_id: "channel-1",
      thread_id: null,
    });
    expect(pool.calls.length).toBe(2);
    expect(pool.calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
  });

  it("blocks mutating promotion when the kill switch is enabled", async () => {
    const previous = process.env.OPENBRAIN_PROMOTION_KILL_SWITCH;
    process.env.OPENBRAIN_PROMOTION_KILL_SWITCH = "1";
    try {
      const sourceId = "123e4567-e89b-12d3-a456-426614174003";
      const pool = createSequencePool([
        [
          {
            id: sourceId,
            namespace: "collab",
            created_by: "legacy-agent",
            content: "legacy shared knowledge",
            content_hash: "hash-kill-switch",
          },
        ],
        [],
      ]);
      const app = buildApp({ role: "admin", clientId: "openbrain-promoter" }, pool);

      const { status, json } = await req(app, "post", "/api/v1/promote", {
        table: "thoughts",
        id: sourceId,
        target_namespace: "shared-kb",
      });

      expect(status).toBe(503);
      expect(json.error).toContain("OPENBRAIN_PROMOTION_KILL_SWITCH");
      expect(pool.calls.length).toBe(2);
      expect(pool.calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBRAIN_PROMOTION_KILL_SWITCH;
      } else {
        process.env.OPENBRAIN_PROMOTION_KILL_SWITCH = previous;
      }
    }
  });

  it("scopes delegated promote source lookup to readable namespaces", async () => {
    const sourceId = "123e4567-e89b-12d3-a456-426614174010";
    const pool = createSequencePool([]);
    const app = buildApp(
      {
        role: "admin",
        clientId: "bilby",
        tokenClientId: "admin",
        namespaceSource: "header",
      },
      pool,
    );

    const { status, json } = await req(app, "post", "/api/v1/promote", {
      table: "thoughts",
      id: sourceId,
      target_namespace: "collab",
    });

    expect(status).toBe(404);
    expect(json.error).toContain("Source entry not found");
    expect(pool.calls[0]!.sql).toContain("namespace = ANY($2::text[])");
    expect(pool.calls[0]!.params).toEqual([sourceId, ["bilby", "shared-kb"]]);
  });

  it("denies delegated promote writes to collab", async () => {
    const sourceId = "123e4567-e89b-12d3-a456-426614174011";
    const pool = createSequencePool([
      [
        {
          id: sourceId,
          namespace: "bilby",
          created_by: "bilby",
          content: "source",
          content_hash: "hash-1",
        },
      ],
    ]);
    const app = buildApp(
      {
        role: "admin",
        clientId: "bilby",
        tokenClientId: "admin",
        namespaceSource: "header",
      },
      pool,
    );

    const { status, json } = await req(app, "post", "/api/v1/promote", {
      table: "thoughts",
      id: sourceId,
      target_namespace: "collab",
    });

    expect(status).toBe(403);
    expect(json.error).toContain("Target namespace read access denied");
    expect(pool.calls.length).toBe(1);
  });

  it("scopes delegated demote lookup and archive update", async () => {
    const promotedId = "123e4567-e89b-12d3-a456-426614174012";
    const pool = createSequencePool([
      [
        {
          id: promotedId,
          namespace: "bilby",
          promoted_from: {
            source_id: "123e4567-e89b-12d3-a456-426614174013",
            source_namespace: "personal",
          },
        },
      ],
      [{ id: promotedId }],
    ]);
    const app = buildApp(
      {
        role: "admin",
        clientId: "bilby",
        tokenClientId: "admin",
        namespaceSource: "header",
      },
      pool,
    );

    const { status, json } = await req(app, "post", "/api/v1/demote", {
      table: "thoughts",
      id: promotedId,
    });

    expect(status).toBe(200);
    expect(json.status).toBe("demoted");
    expect(pool.calls[0]!.sql).toContain("namespace = ANY($2::text[])");
    expect(pool.calls[0]!.params).toEqual([promotedId, ["bilby", "shared-kb"]]);
    expect(pool.calls[1]!.sql).toContain("namespace = ANY($2::text[])");
    expect(pool.calls[1]!.params).toEqual([promotedId, ["bilby"]]);
  });

  it("returns 400 for invalid scan limit", async () => {
    const pool = createSequencePool([]);
    const app = buildApp({ role: "admin", clientId: "rico" }, pool);

    const { status } = await req(app, "get", "/api/v1/scan/bilby?limit=-1");

    expect(status).toBe(400);
    expect(pool.calls.length).toBe(0);
  });

  it("denies delegated scans outside the delegated source namespace", async () => {
    const pool = createSequencePool([]);
    const app = buildApp(
      {
        role: "admin",
        clientId: "bilby",
        tokenClientId: "admin",
        namespaceSource: "header",
      },
      pool,
    );

    const { status, json } = await req(app, "get", "/api/v1/scan/skippy");

    expect(status).toBe(403);
    expect(json.error).toContain("namespace read access denied");
    expect(pool.calls.length).toBe(0);
  });

  it("denies delegated scans against unreadable target namespaces", async () => {
    const pool = createSequencePool([]);
    const app = buildApp(
      {
        role: "admin",
        clientId: "bilby",
        tokenClientId: "admin",
        namespaceSource: "header",
      },
      pool,
    );

    const { status, json } = await req(
      app,
      "get",
      "/api/v1/scan/bilby?target_namespace=team",
    );

    expect(status).toBe(403);
    expect(json.error).toContain("target namespace read access denied");
    expect(pool.calls.length).toBe(0);
  });

  it("scans duplicates against a requested target namespace", async () => {
    const pool = createSequencePool([
      [
        {
          id: "source-1",
          namespace: "bilby",
          content_hash: "hash-1",
          created_at: "2026-06-10T00:00:00.000Z",
          promoted_from: null,
        },
      ],
      [{ id: "team-1" }],
    ]);
    const app = buildApp({ role: "admin", clientId: "rico" }, pool);

    const { status, json } = await req(
      app,
      "get",
      "/api/v1/scan/bilby?table=thoughts&target_namespace=team",
    );

    expect(status).toBe(200);
    expect(pool.calls[1]!.sql).toContain("namespace = $2");
    expect(pool.calls[1]!.params).toEqual(["hash-1", "team"]);
    expect(json).toMatchObject({
      namespace: "bilby",
      target_namespace: "team",
      duplicates: [
        {
          table: "thoughts",
          id: "source-1",
          target_namespace: "team",
          existing_target_id: "team-1",
        },
      ],
    });
    expect(json.duplicates[0].existing_collab_id).toBeUndefined();
  });
});
