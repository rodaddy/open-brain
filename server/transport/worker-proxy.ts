import type { Logger } from "pino";

export interface WorkerTarget {
  readonly name: string;
  readonly port: number;
  readonly baseUrl: string;
}

export interface WorkerHealthResult {
  readonly name: string;
  readonly port: number;
  readonly ok: boolean;
  readonly status?: number;
  readonly body?: unknown;
  readonly error_category?: string;
}

export interface AggregateHealth {
  readonly status: "healthy" | "degraded";
  readonly server_ip: string;
  readonly server_ips: readonly string[];
  readonly workers: readonly WorkerHealthResult[];
  readonly timestamp: string;
}

export interface WorkerProxyInput {
  readonly workers: readonly WorkerTarget[];
  readonly serverIp: string;
  readonly healthProbeTimeoutMs: number;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
}

export type WorkerProxyHandler = (request: Request) => Promise<Response>;

async function readHealthBody(
  response: Response,
  worker: WorkerTarget,
  logger: Logger,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: unknown) {
    logger.warn(
      {
        worker: worker.name,
        error_category: error instanceof Error ? error.name : typeof error,
      },
      "worker_health_body_invalid",
    );
    return null;
  }
}

async function workerHealth(
  input: WorkerProxyInput,
  worker: WorkerTarget,
): Promise<WorkerHealthResult> {
  try {
    const response = await (input.fetch ?? fetch)(
      new URL("/health", worker.baseUrl),
      { signal: AbortSignal.timeout(input.healthProbeTimeoutMs) },
    );
    return {
      name: worker.name,
      port: worker.port,
      ok: response.ok,
      status: response.status,
      body: await readHealthBody(response, worker, input.logger),
    };
  } catch (error: unknown) {
    const errorCategory = error instanceof Error ? error.name : typeof error;
    input.logger.warn(
      { worker: worker.name, error_category: errorCategory },
      "worker_health_failed",
    );
    return {
      name: worker.name,
      port: worker.port,
      ok: false,
      error_category: errorCategory,
    };
  }
}

/** Build the aggregate front as a pure fetch handler; the caller owns any socket. */
export function createWorkerProxyHandler(input: WorkerProxyInput): WorkerProxyHandler {
  if (input.workers.length === 0) {
    throw new Error("worker_proxy_requires_at_least_one_worker");
  }
  const fetchWorker = input.fetch ?? fetch;
  const sessionWorkers = new Map<string, WorkerTarget>();
  let nextWorker = 0;

  return async (request) => {
    const incomingUrl = new URL(request.url);
    if (incomingUrl.pathname === "/health") {
      const workers = await Promise.all(
        input.workers.map((worker) => workerHealth(input, worker)),
      );
      const healthy = workers.every((worker) => worker.ok);
      const health: AggregateHealth = {
        status: healthy ? "healthy" : "degraded",
        server_ip: input.serverIp,
        server_ips: [input.serverIp],
        workers,
        timestamp: new Date().toISOString(),
      };
      input.logger.info(
        { status: health.status, worker_count: workers.length },
        "aggregate_health_result",
      );
      return Response.json(health, { status: healthy ? 200 : 503 });
    }

    const sessionId = request.headers.get("mcp-session-id");
    let worker = sessionId ? sessionWorkers.get(sessionId) : undefined;
    worker ??= input.workers[nextWorker % input.workers.length];
    if (!worker) {
      input.logger.error("worker_proxy_unavailable");
      return Response.json({ error: "No Open Brain workers configured" }, { status: 503 });
    }
    if (!sessionId) nextWorker += 1;

    const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, worker.baseUrl);
    const headers = new Headers(request.headers);
    headers.set("x-open-brain-worker", worker.name);
    headers.delete("host");
    const response = await fetchWorker(targetUrl, {
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
    if (responseSessionId) sessionWorkers.set(responseSessionId, worker);
    if (sessionId && request.method === "DELETE" && response.ok) {
      sessionWorkers.delete(sessionId);
    }
    input.logger.info(
      {
        method: request.method,
        worker: worker.name,
        status: response.status,
        session_affinity: Boolean(sessionId || responseSessionId),
      },
      "worker_proxy_result",
    );
    return response;
  };
}
