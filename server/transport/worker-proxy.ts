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
  readonly hostname: string;
  readonly server_ip: string;
  readonly server_ips: readonly string[];
  readonly revision?: string;
  readonly workers: readonly WorkerHealthResult[];
  readonly timestamp: string;
}

export interface WorkerProxyInput {
  readonly workers: readonly WorkerTarget[];
  readonly hostname: string;
  readonly serverIp: string;
  readonly serverIps: readonly string[];
  readonly revision?: string | undefined;
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

interface ProxyState {
  readonly input: WorkerProxyInput;
  readonly fetchWorker: typeof fetch;
  readonly sessionWorkers: Map<string, WorkerTarget>;
  nextWorker: number;
}

async function aggregateHealthResponse(
  input: WorkerProxyInput,
): Promise<Response> {
  const workers = await Promise.all(
    input.workers.map((worker) => workerHealth(input, worker)),
  );
  const healthy = workers.every((worker) => worker.ok);
  const health: AggregateHealth = {
    status: healthy ? "healthy" : "degraded",
    hostname: input.hostname,
    server_ip: input.serverIp,
    server_ips: input.serverIps,
    ...(input.revision ? { revision: input.revision } : {}),
    workers,
    timestamp: new Date().toISOString(),
  };
  input.logger.info(
    { status: health.status, worker_count: workers.length },
    "aggregate_health_result",
  );
  return Response.json(health, { status: healthy ? 200 : 503 });
}

/** Sticky by session id when present, else round-robin; advancing only on unsessioned calls. */
function selectWorker(
  state: ProxyState,
  sessionId: string | null,
): WorkerTarget | undefined {
  const workers = state.input.workers;
  let worker = sessionId ? state.sessionWorkers.get(sessionId) : undefined;
  worker ??= workers[state.nextWorker % workers.length];
  if (worker && !sessionId) state.nextWorker += 1;
  return worker;
}

function forwardHeaders(request: Request, worker: WorkerTarget): Headers {
  const headers = new Headers(request.headers);
  headers.set("x-open-brain-worker", worker.name);
  headers.delete("host");
  return headers;
}

async function forwardToWorker(
  state: ProxyState,
  request: Request,
  incomingUrl: URL,
  worker: WorkerTarget,
): Promise<Response> {
  const targetUrl = new URL(
    incomingUrl.pathname + incomingUrl.search,
    worker.baseUrl,
  );
  const response = await state.fetchWorker(targetUrl, {
    method: request.method,
    headers: forwardHeaders(request, worker),
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual",
    signal: request.signal,
  });

  const sessionId = request.headers.get("mcp-session-id");
  const responseSessionId = response.headers.get("mcp-session-id");
  if (responseSessionId) state.sessionWorkers.set(responseSessionId, worker);
  if (sessionId && request.method === "DELETE" && response.ok) {
    state.sessionWorkers.delete(sessionId);
  }
  state.input.logger.info(
    {
      method: request.method,
      worker: worker.name,
      status: response.status,
      session_affinity: Boolean(sessionId || responseSessionId),
    },
    "worker_proxy_result",
  );
  return response;
}

/** Build the aggregate front as a pure fetch handler; the caller owns any socket. */
export function createWorkerProxyHandler(
  input: WorkerProxyInput,
): WorkerProxyHandler {
  if (input.workers.length === 0) {
    throw new Error("worker_proxy_requires_at_least_one_worker");
  }
  const state: ProxyState = {
    input,
    fetchWorker: input.fetch ?? fetch,
    sessionWorkers: new Map<string, WorkerTarget>(),
    nextWorker: 0,
  };

  return async (request) => {
    const incomingUrl = new URL(request.url);
    if (incomingUrl.pathname === "/health") {
      return await aggregateHealthResponse(input);
    }

    const worker = selectWorker(state, request.headers.get("mcp-session-id"));
    if (!worker) {
      input.logger.error("worker_proxy_unavailable");
      return Response.json(
        { error: "No Open Brain workers configured" },
        { status: 503 },
      );
    }

    return await forwardToWorker(state, request, incomingUrl, worker);
  };
}
