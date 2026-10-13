export interface JevFailureMetadata {
  readonly failure_stage: "http" | "response" | "decision";
  readonly failure_code: string;
  readonly http_status?: number;
}

const metadataByError = new WeakMap<object, JevFailureMetadata>();
const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
  "ZodError",
]);

function safeTraceError(error: unknown): Error {
  const traceError = new Error("Jev provider operation failed");
  if (error instanceof Error && SAFE_ERROR_NAMES.has(error.name)) {
    traceError.name = error.name;
  }
  return traceError;
}

export function classifyJevFailure(
  error: unknown,
  metadata: JevFailureMetadata,
): unknown {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    metadataByError.set(error, metadata);
  }
  return error;
}

function readJevFailureMetadata(error: unknown): JevFailureMetadata | undefined {
  if ((typeof error !== "object" || error === null) && typeof error !== "function")
    return undefined;
  return metadataByError.get(error);
}

export type JevFailureReason =
  "timeout" | "http" | "size" | "invalid_answer" | "network" | "other";

/** Content-free account of why a Jev call failed: never bodies or record text. */
export interface JevFailureDescriptor {
  readonly reason: JevFailureReason;
  readonly status: number | null;
}

const REASON_BY_FAILURE_CODE: Readonly<Record<string, JevFailureReason>> = {
  http_status: "http",
  request_failed: "network",
  invalid_json: "invalid_answer",
  invalid_schema: "invalid_answer",
  incomplete_classifier_answers: "invalid_answer",
  invalid_classifier_answer: "invalid_answer",
  invalid_relevance_answer: "invalid_answer",
};
const TIMEOUT_ERROR_NAMES = new Set(["TimeoutError", "AbortError"]);

/** Map a thrown Jev failure onto a reason, reusing the classifyJevFailure metadata. */
export function describeJevFailure(error: unknown): JevFailureDescriptor {
  const name = error instanceof Error ? error.name : "";
  if (name === "JevBatchTooLargeError") return { reason: "size", status: null };
  const metadata = readJevFailureMetadata(error);
  const reason = REASON_BY_FAILURE_CODE[metadata?.failure_code ?? ""] ?? "other";
  if (reason === "network" && TIMEOUT_ERROR_NAMES.has(name)) {
    return { reason: "timeout", status: null };
  }
  return { reason, status: metadata?.http_status ?? null };
}

/** Record only safe Jev failure fields while returning the original error to callers. */
export async function observeJevFailureSafely<T>(
  work: () => Promise<T>,
  metadata: Record<string, unknown>,
  observe: (
    safeWork: () => Promise<T>,
    failureMetadata: Record<string, unknown>,
  ) => Promise<T>,
): Promise<T> {
  const failureMetadata: Record<string, unknown> = { ...metadata };
  let originalError: unknown;
  let workFailed = false;
  try {
    return await observe(async () => {
      try {
        return await work();
      } catch (error: unknown) {
        workFailed = true;
        originalError = error;
        Object.assign(failureMetadata, readJevFailureMetadata(error));
        throw safeTraceError(error);
      }
    }, failureMetadata);
  } catch (error: unknown) {
    if (workFailed) throw originalError;
    throw error;
  }
}
