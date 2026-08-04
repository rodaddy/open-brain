/**
 * Aggregate worker front boundary tests.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` phase 4 freezes the
 * aggregate behavior of `scripts/run-two-worker.ts` -- `workers[]` appears ONLY
 * here and never in a single worker's own health, session affinity pins a
 * session to the worker that issued it, and DELETE releases that pin.
 *
 * The handler is a pure `Request -> Response` function and `fetch` is injected,
 * so this test binds no port.
 */
import { describe, expect, it } from "bun:test";
import { createWorkerProxyHandler } from "./index.ts";
import type { AggregateHealth, WorkerProxyInput, WorkerTarget } from "./index.ts";
import { silentLogger } from "./testing/silent-logger.ts";

const WORKERS: readonly WorkerTarget[] = [
  { name: "open-brain-worker-1", port: 3101, baseUrl: "http://127.0.0.1:3101" },
  { name: "open-brain-worker-2", port: 3102, baseUrl: "http://127.0.0.1:3102" },
];

interface ProxiedCall {
  readonly url: string;
  readonly method: string;
  readonly worker: string | null;
  readonly host: string | null;
}

function handlerWith(options: {
  readonly onFetch: (url: URL, init: RequestInit | undefined) => Response;
  readonly calls?: ProxiedCall[];
  readonly workers?: readonly WorkerTarget[];
}) {
  const input: WorkerProxyInput = {
    workers: options.workers ?? WORKERS,
    hostname: "core01",
    serverIp: "10.71.1.21",
    serverIps: ["10.71.1.21"],
    healthProbeTimeoutMs: 3_000,
    logger: silentLogger(),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      const headers = new Headers(init?.headers);
      options.calls?.push({
        url: target.toString(),
        method: init?.method ?? "GET",
        worker: headers.get("x-open-brain-worker"),
        host: headers.get("host"),
      });
      return options.onFetch(target, init);
    }) as unknown as typeof fetch,
  };
  return createWorkerProxyHandler(input);
}

function mcpRequest(options?: {
  readonly method?: string;
  readonly sessionId?: string;
}): Request {
  const headers = new Headers({ host: "10.71.1.21:3100" });
  if (options?.sessionId) headers.set("mcp-session-id", options.sessionId);
  const method = options?.method ?? "POST";
  return new Request("http://10.71.1.21:3100/mcp", {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  });
}

function healthResponse(status = 200): Response {
  return Response.json({ status: status === 200 ? "healthy" : "degraded" }, { status });
}

describe("aggregate worker front boundary", () => {
  it("reports every worker in the aggregate health roster", async () => {
    const handler = handlerWith({ onFetch: () => healthResponse() });
    const response = await handler(new Request("http://10.71.1.21:3100/health"));
    const body = (await response.json()) as AggregateHealth;

    expect(response.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.server_ip).toBe("10.71.1.21");
    expect(body.workers.map((worker) => worker.name)).toEqual([
      "open-brain-worker-1",
      "open-brain-worker-2",
    ]);
    expect(body.workers.every((worker) => worker.ok)).toBe(true);
  });

  it("degrades the aggregate when any single worker is unhealthy", async () => {
    const handler = handlerWith({
      onFetch: (url) => healthResponse(url.port === "3102" ? 503 : 200),
    });
    const response = await handler(new Request("http://10.71.1.21:3100/health"));
    const body = (await response.json()) as AggregateHealth;

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.workers.find((worker) => worker.port === 3102)?.ok).toBe(false);
    expect(body.workers.find((worker) => worker.port === 3101)?.ok).toBe(true);
  });

  it("records an unreachable worker as a category rather than a raw error", async () => {
    const handler = handlerWith({
      onFetch: (url) => {
        if (url.port === "3101") throw new TypeError("connect ECONNREFUSED 127.0.0.1:3101");
        return healthResponse();
      },
    });
    const body = (await (
      await handler(new Request("http://10.71.1.21:3100/health"))
    ).json()) as AggregateHealth;

    const failed = body.workers.find((worker) => worker.port === 3101);
    expect(failed?.ok).toBe(false);
    expect(failed?.error_category).toBe("TypeError");
    expect(JSON.stringify(failed)).not.toContain("ECONNREFUSED");
  });

  it("spreads sessionless requests across workers instead of pinning one", async () => {
    const calls: ProxiedCall[] = [];
    const handler = handlerWith({ calls, onFetch: () => new Response("ok") });

    await handler(mcpRequest());
    await handler(mcpRequest());
    await handler(mcpRequest());

    expect(calls.map((call) => call.worker)).toEqual([
      "open-brain-worker-1",
      "open-brain-worker-2",
      "open-brain-worker-1",
    ]);
  });

  it("pins a session to the worker that issued it and keeps it there", async () => {
    const calls: ProxiedCall[] = [];
    const sessionId = "8f1c1f6e-2c5e-4a2b-8d3a-9c1f6e2c5e4a";
    const handler = handlerWith({
      calls,
      onFetch: (url) =>
        url.port === "3101"
          ? new Response("ok", { headers: { "mcp-session-id": sessionId } })
          : new Response("ok"),
    });

    await handler(mcpRequest());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await handler(mcpRequest({ sessionId }));
    }

    expect(calls.map((call) => call.worker)).toEqual([
      "open-brain-worker-1",
      "open-brain-worker-1",
      "open-brain-worker-1",
      "open-brain-worker-1",
    ]);
  });

  it("releases the session pin once the client deletes the session", async () => {
    const calls: ProxiedCall[] = [];
    const sessionId = "8f1c1f6e-2c5e-4a2b-8d3a-9c1f6e2c5e4a";
    const handler = handlerWith({
      calls,
      onFetch: (url) =>
        url.port === "3101"
          ? new Response("ok", { headers: { "mcp-session-id": sessionId } })
          : new Response("ok"),
    });

    await handler(mcpRequest());
    await handler(mcpRequest({ method: "DELETE", sessionId }));
    await handler(mcpRequest());

    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE", "POST"]);
    expect(calls[2]?.worker).toBe("open-brain-worker-2");
  });

  it("forwards path and query to the chosen worker and strips the inbound host", async () => {
    const calls: ProxiedCall[] = [];
    const handler = handlerWith({ calls, onFetch: () => new Response("ok") });

    await handler(
      new Request("http://10.71.1.21:3100/mcp?trace=1", {
        method: "POST",
        headers: { host: "10.71.1.21:3100" },
        body: "{}",
      }),
    );

    expect(calls[0]?.url).toBe("http://127.0.0.1:3101/mcp?trace=1");
    expect(calls[0]?.host).toBeNull();
    expect(calls[0]?.worker).toBe("open-brain-worker-1");
  });

  it("refuses to build a front with no workers behind it", () => {
    expect(() =>
      createWorkerProxyHandler({
        workers: [],
        hostname: "core01",
        serverIp: "10.71.1.21",
        serverIps: ["10.71.1.21"],
        healthProbeTimeoutMs: 3_000,
        logger: silentLogger(),
      }),
    ).toThrow("worker_proxy_requires_at_least_one_worker");
  });
});
