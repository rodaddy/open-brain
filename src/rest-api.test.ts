import { describe, it, expect } from "bun:test";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createRestRouter } from "./rest-api.ts";
import type { AuthInfo } from "./types.ts";

function createMockPool(rows: Record<string, unknown>[] = [{ id: "test-uuid" }]) {
  return {
    query: async () => ({ rows }),
  };
}

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

function buildApp(
  auth: AuthInfo,
  pool?: ReturnType<typeof createMockPool>,
  embed?: ReturnType<typeof createMockEmbed>,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).auth = auth;
    next();
  });
  const deps = {
    pool: (pool ?? createMockPool()) as any,
    embedFn: embed ?? createMockEmbed(),
  };
  app.use("/api/v1", createRestRouter(deps));
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
  const port = 19000 + Math.floor(Math.random() * 1000);

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

describe("REST API", () => {
  describe("POST /api/v1/thoughts", () => {
    it("creates a thought and returns 201", async () => {
      const pool = createMockPool([{ id: "t-uuid", is_new: true }]);
      const app = buildApp({ role: "agent", clientId: "bilby" }, pool);

      const { status, json } = await req(app, "post", "/api/v1/thoughts", {
        content: "A test thought",
        tags: ["test"],
      });

      expect(status).toBe(201);
      expect(json.id).toBe("t-uuid");
      expect(json.namespace).toBe("bilby");
      expect(json.embedded).toBe(true);
    });

    it("returns 400 when content is missing", async () => {
      const app = buildApp({ role: "agent", clientId: "bilby" });
      const { status, json } = await req(app, "post", "/api/v1/thoughts", {});

      expect(status).toBe(400);
      expect(json.error).toContain("content");
    });

    it("returns 403 for cross-namespace write", async () => {
      const app = buildApp({ role: "agent", clientId: "bilby" });
      const { status, json } = await req(app, "post", "/api/v1/thoughts", {
        content: "cross write",
        namespace: "nagatha",
      });

      expect(status).toBe(403);
      expect(json.error).toContain("Permission denied");
    });

    it("allows admin to write to any namespace", async () => {
      const pool = createMockPool([{ id: "admin-uuid", is_new: true }]);
      const app = buildApp({ role: "admin", clientId: "rico" }, pool);

      const { status, json } = await req(app, "post", "/api/v1/thoughts", {
        content: "admin thought",
        namespace: "bilby",
      });

      expect(status).toBe(201);
      expect(json.namespace).toBe("bilby");
    });
  });

  describe("POST /api/v1/decisions", () => {
    it("creates a decision and returns 201", async () => {
      const pool = createMockPool([{ id: "d-uuid", is_new: true }]);
      const app = buildApp({ role: "agent", clientId: "bilby" }, pool);

      const { status, json } = await req(app, "post", "/api/v1/decisions", {
        title: "Use REST",
        rationale: "Simpler for Python clients",
      });

      expect(status).toBe(201);
      expect(json.id).toBe("d-uuid");
      expect(json.namespace).toBe("bilby");
    });

    it("returns 400 when title/rationale missing", async () => {
      const app = buildApp({ role: "agent", clientId: "bilby" });
      const { status } = await req(app, "post", "/api/v1/decisions", {
        title: "Missing rationale",
      });

      expect(status).toBe(400);
    });
  });

  describe("POST /api/v1/persons", () => {
    it("creates a person and returns 201", async () => {
      const pool = createMockPool([{ id: "p-uuid", inserted: true }]);
      const app = buildApp({ role: "agent", clientId: "bilby" }, pool);

      const { status, json } = await req(app, "post", "/api/v1/persons", {
        name: "Rico",
        context: "Owner",
      });

      expect(status).toBe(201);
      expect(json.person_name).toBe("Rico");
      expect(json.action).toBe("created");
    });
  });

  describe("POST /api/v1/sessions", () => {
    it("creates a session and returns 201", async () => {
      const pool = createMockPool([{ id: "s-uuid" }]);
      const app = buildApp({ role: "agent", clientId: "bilby" }, pool);

      const { status, json } = await req(app, "post", "/api/v1/sessions", {
        summary: "Worked on namespace writes",
        project: "open-brain",
      });

      expect(status).toBe(201);
      expect(json.id).toBe("s-uuid");
      expect(json.namespace).toBe("bilby");
    });
  });

  describe("GET /api/v1/entries/:table/:id", () => {
    it("returns entry by table and id", async () => {
      const pool = createMockPool([
        { id: "e-uuid", content: "test thought", namespace: "bilby" },
      ]);
      const app = buildApp({ role: "admin", clientId: "rico" }, pool);

      const { status, json } = await req(
        app,
        "get",
        "/api/v1/entries/thoughts/e-uuid",
      );

      expect(status).toBe(200);
      expect(json.id).toBe("e-uuid");
      expect(json.content).toBe("test thought");
    });

    it("returns 404 when entry not found", async () => {
      const pool = createMockPool([]);
      const app = buildApp({ role: "admin", clientId: "rico" }, pool);

      const { status } = await req(
        app,
        "get",
        "/api/v1/entries/thoughts/00000000-0000-0000-0000-000000000000",
      );

      expect(status).toBe(404);
    });

    it("returns 400 for invalid table", async () => {
      const app = buildApp({ role: "admin", clientId: "rico" });
      const { status } = await req(
        app,
        "get",
        "/api/v1/entries/invalid/some-id",
      );

      expect(status).toBe(400);
    });
  });

  describe("GET /api/v1/namespaces", () => {
    it("returns namespace breakdown", async () => {
      const pool = {
        query: async () => ({
          rows: [
            { table_name: "thoughts", namespace: "bilby", count: "5" },
            { table_name: "thoughts", namespace: "collab", count: "10" },
          ],
        }),
      };
      const app = buildApp({ role: "admin", clientId: "rico" }, pool as any);

      const { status, json } = await req(app, "get", "/api/v1/namespaces");

      expect(status).toBe(200);
      expect(json.namespace_count).toBeGreaterThan(0);
      expect(json.namespaces[0].namespace).toBe("collab");
    });
  });

  describe("auth enforcement", () => {
    it("returns 403 for readonly role writing thoughts", async () => {
      const app = buildApp({ role: "readonly", clientId: "viewer" });
      const { status } = await req(app, "post", "/api/v1/thoughts", {
        content: "should fail",
      });

      expect(status).toBe(403);
    });
  });
});
