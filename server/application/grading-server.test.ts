import { describe, expect, it, vi } from "vitest";

import { startGradingServer } from "./grading-server.ts";

const options = () => ({
  pool: { query: vi.fn(() => Promise.reject(new Error("normal route ran"))) },
  namespace: "rico",
  gradedBy: "rico",
});

describe("makeGradingHandler frozen review seam", () => {
  it("dispatches an opted-in request only to the frozen review handler", async () => {
    const normal = options();
    let seen: Request | undefined;
    const server = await startGradingServer({
      ...normal,
      port: 0,
      frozenReviewHandler: async (request) => {
        seen = request;
        return Response.json({ source: "frozen" });
      },
    });

    try {
      const response = await fetch(`${server.url}api/queue?limit=1`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ source: "frozen" });
      expect(seen?.url).toBe(`${server.url}api/queue?limit=1`);
      expect(normal.pool.query).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("maps frozen review handler failures through the existing error boundary", async () => {
    const server = await startGradingServer({
      ...options(),
      port: 0,
      frozenReviewHandler: async () => {
        throw new Error("sentinel frozen failure");
      },
    });

    try {
      const response = await fetch(`${server.url}frozen`);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal error" });
    } finally {
      await server.stop();
    }
  });

  it("preserves normal dispatch when the frozen review handler is absent", async () => {
    const server = await startGradingServer({ ...options(), port: 0 });

    try {
      const response = await fetch(`${server.url}health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "ok",
        namespace: "rico",
        graded_by: "rico",
      });
    } finally {
      await server.stop();
    }
  });
});
