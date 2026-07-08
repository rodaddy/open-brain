#!/usr/bin/env bun

import { buildHttpWorkerEnv } from "./worker-env.ts";

type WorkerConfig = {
  name: string;
  port: number;
  runMigrations: boolean;
};

const publicPort = parseInt(process.env.OPEN_BRAIN_PUBLIC_PORT ?? "3100", 10);
const workerPorts = (process.env.OPEN_BRAIN_WORKER_PORTS ?? "3101,3102")
  .split(",")
  .map((port) => parseInt(port.trim(), 10))
  .filter((port) => Number.isFinite(port) && port > 0);
const workerCount = parseInt(process.env.OPEN_BRAIN_WORKERS ?? "2", 10);
const poolMax = process.env.OPEN_BRAIN_WORKER_DB_POOL_MAX ?? "5";

function serverIps(): string[] {
  const configured = process.env.OPEN_BRAIN_SERVER_IP?.trim();
  if (configured) return [configured];

  return ["unknown"];
}

if (workerCount < 1) {
  throw new Error("OPEN_BRAIN_WORKERS must be at least 1");
}
if (workerPorts.length < workerCount) {
  throw new Error(
    `OPEN_BRAIN_WORKER_PORTS must include at least ${workerCount} ports`,
  );
}

const workers: WorkerConfig[] = Array.from({ length: workerCount }, (_, index) => {
  const port = workerPorts[index];
  if (!port) {
    throw new Error(`Missing worker port for worker ${index + 1}`);
  }
  return {
    name: `open-brain-worker-${index + 1}`,
    port,
    runMigrations: index === 0,
  };
});

const children = workers.map((worker) => {
  const child = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: buildHttpWorkerEnv({
      baseEnv: process.env,
      port: worker.port,
      poolMax,
      runMigrations: worker.runMigrations,
      workerName: worker.name,
    }),
    stdout: "inherit",
    stderr: "inherit",
  });
  console.log(
    `${worker.name} starting on :${worker.port} migrations=${worker.runMigrations}`,
  );
  return { worker, child };
});

let nextWorker = 0;
const mcpSessions = new Map<string, WorkerConfig>();

async function workerHealth(worker: WorkerConfig) {
  try {
    const response = await fetch(`http://127.0.0.1:${worker.port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json().catch(() => null);
    return {
      name: worker.name,
      port: worker.port,
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (err) {
    return {
      name: worker.name,
      port: worker.port,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function proxyRequest(request: Request): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");
  let worker = sessionId ? mcpSessions.get(sessionId) : undefined;
  worker ??= workers[nextWorker % workers.length];
  if (!worker) {
    return Response.json({ error: "No Open Brain workers configured" }, { status: 503 });
  }
  if (!sessionId) {
    nextWorker += 1;
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, `http://127.0.0.1:${worker.port}`);
  const headers = new Headers(request.headers);
  headers.set("x-open-brain-worker", worker.name);
  headers.delete("host");

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual",
    signal: request.signal,
  });

  const responseSessionId = response.headers.get("mcp-session-id");
  if (responseSessionId) {
    mcpSessions.set(responseSessionId, worker);
  }
  if (sessionId && request.method === "DELETE" && response.ok) {
    mcpSessions.delete(sessionId);
  }

  return response;
}

const proxy = Bun.serve({
  port: publicPort,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const results = await Promise.all(workers.map(workerHealth));
      const healthy = results.every((result) => result.ok);
      const ips = serverIps();
      return Response.json(
        {
          status: healthy ? "healthy" : "degraded",
          server_ip: ips[0] ?? "unknown",
          server_ips: ips,
          workers: results,
          timestamp: new Date().toISOString(),
        },
        { status: healthy ? 200 : 503 },
      );
    }

    return proxyRequest(request);
  },
});

console.log(
  `open-brain proxy listening on :${publicPort} for workers ${workers
    .map((worker) => `:${worker.port}`)
    .join(", ")}`,
);

async function shutdown() {
  console.log("Shutting down open-brain two-worker launcher...");
  proxy.stop(true);
  await Promise.all(
    children.map(async ({ child }) => {
      child.kill("SIGTERM");
      await child.exited;
    }),
  );
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

const exits = children.map(async ({ worker, child }) => {
  const code = await child.exited;
  throw new Error(`${worker.name} exited with code ${code}`);
});

await Promise.race(exits);
