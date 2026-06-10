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
      return { rows: rowSets.shift() ?? [] };
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

  it("returns 400 for invalid scan limit", async () => {
    const pool = createSequencePool([]);
    const app = buildApp({ role: "admin", clientId: "rico" }, pool);

    const { status } = await req(app, "get", "/api/v1/scan/bilby?limit=-1");

    expect(status).toBe(400);
    expect(pool.calls.length).toBe(0);
  });
});
