/**
 * Shared fixtures and fakes for the eval-langfuse-egress test siblings.
 *
 * The suite was one 532-line describe in scripts/eval-langfuse-egress.test.ts.
 * It is split by subject into sibling test files; everything they share lives
 * here so no fixture is duplicated and drifts.
 */
import {
  verifyLangfuseEgress,
  type HttpTransport,
  type LangfuseReadConfig,
} from "../eval-langfuse-egress.ts";

export const CONFIG: LangfuseReadConfig = {
  endpoint: "https://langfuse.example",
  publicKey: "public-id",
  secretKey: "private-id",
};

export const OPTED_IN_ENV = {
  OPEN_BRAIN_LANGFUSE_EGRESS: "1",
  OPENBRAIN_TRACING_ENABLED: "1",
  OPENBRAIN_TRACING_ENDPOINT: "https://langfuse.example/api/public/ingestion",
  OPENBRAIN_TRACING_PUBLIC_KEY: "public-id",
  OPENBRAIN_TRACING_SECRET_KEY: "private-id",
};

export const CAPTURE_DRIVE_ENV = {
  ...OPTED_IN_ENV,
  OPENBRAIN_CAPTURE_BASE_URL: "http://127.0.0.1:3100",
  OPENBRAIN_CAPTURE_TOKEN: "capture-token",
};

/**
 * Resolve an HttpTransport's `input` to the URL it addresses.
 *
 * HttpTransport accepts `string | URL | Request`. `String(input)` is correct
 * for the first two and silently yields "[object Object]" for a Request, so
 * the Request arm reads its own `.url` instead of being stringified.
 */
export function transportUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

export interface FakeObservationOptions {
  usage?: boolean;
  cost?: number | null;
  output?: unknown;
}

export function generation(
  options: FakeObservationOptions = {},
): Record<string, unknown> {
  return {
    id: "observation-1",
    type: "GENERATION",
    model: "claude-fable-5",
    usageDetails: options.usage === false ? undefined : { input: 2, output: 3 },
    totalPrice: options.cost === undefined ? 0.001 : options.cost,
    output: options.output ?? "SAFE_BODY_MARKER",
  };
}

export function fakeTransport(
  observations: unknown[],
  bodyExtras: Record<string, unknown> = {},
): HttpTransport {
  return async (input) => {
    const url = transportUrl(input);
    if (url.pathname === "/api/public/traces") {
      return Response.json({
        data: [{ id: "trace-1" }],
        meta: { totalPages: 1 },
      });
    }
    if (url.pathname === "/api/public/traces/trace-1") {
      return Response.json({
        id: "trace-1",
        sessionId: "run-tag",
        tags: ["open-brain-capture"],
        observations,
        ...bodyExtras,
      });
    }
    return new Response(null, { status: 404 });
  };
}

export async function verify(
  observations: unknown[],
  options: {
    expected?: number;
    expectedTraces?: number;
    requireCost?: boolean;
    body?: Record<string, unknown>;
    settleTimeoutSeconds?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    transport?: HttpTransport;
  } = {},
) {
  return verifyLangfuseEgress({
    tag: "run-tag",
    expectedObservations: options.expected ?? 1,
    expectedTraces: options.expectedTraces,
    requireCost: options.requireCost,
    settleTimeoutSeconds: options.settleTimeoutSeconds ?? 0,
    pollIntervalMs: options.pollIntervalMs,
    now: options.now,
    sleep: options.sleep,
    config: CONFIG,
    transport: options.transport ?? fakeTransport(observations, options.body),
  });
}

export function check(receipt: Awaited<ReturnType<typeof verify>>, label: string) {
  const found = receipt.checks.find((item) => item.label === label);
  if (!found) throw new Error(`missing check ${label}`);
  return found;
}
