import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { JevFetch } from "../server/integrations/jev.ts";

export const PAID_MODEL = "jev-1.13.0";
export const MAX_PAID_ATTEMPTS = 100;
const MAX_INPUT_TOKENS = 64_000;
const INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;
const RESERVED_USD_PER_ATTEMPT = MAX_INPUT_TOKENS * INPUT_USD_PER_TOKEN;

interface PaidTotals {
  readonly attempts: number;
  readonly stopped: boolean;
  readonly reportedInputTokens: number;
  readonly actualReportedUsd: number;
  readonly reservedMaximumUsd: number;
}

export interface PaidAttemptGuard {
  readonly fetch: JevFetch;
  readonly totals: () => PaidTotals;
  readonly close: () => void;
}

interface LedgerState {
  fd: number;
  attempts: number;
  stopped: boolean;
  reportedInputTokens: number;
}

function append(state: LedgerState, entry: Record<string, unknown>): void {
  writeSync(state.fd, `${JSON.stringify(entry)}\n`);
  fsyncSync(state.fd);
}

function latch(
  state: LedgerState,
  ordinal: number,
  status: string,
  requestId: string | null,
): void {
  state.stopped = true;
  append(state, {
    ordinal,
    timestamp: new Date().toISOString(),
    status,
    request_id: requestId,
  });
}

function reserve(state: LedgerState, maxAttempts: number): number {
  if (state.stopped) throw new Error("paid V1 stopped after an ambiguous attempt");
  if (state.attempts >= maxAttempts) {
    state.stopped = true;
    throw new Error(`paid V1 physical-attempt cap ${maxAttempts} reached`);
  }
  state.attempts += 1;
  append(state, {
    ordinal: state.attempts,
    timestamp: new Date().toISOString(),
    status: "reserved",
    reserved_usd: RESERVED_USD_PER_ATTEMPT,
  });
  return state.attempts;
}

function requestIdOf(response: Response): string | null {
  const value = response.headers.get("x-typesafe-request-id");
  return value !== null && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : null;
}

function validUsage(inputTokens: unknown, outputTokens: unknown): boolean {
  return (
    Number.isInteger(inputTokens) &&
    Number.isInteger(outputTokens) &&
    Number(inputTokens) >= 0 &&
    Number(inputTokens) <= MAX_INPUT_TOKENS &&
    Number(outputTokens) >= 0
  );
}

function responseFields(body: unknown): {
  model: unknown;
  inputTokens: unknown;
  outputTokens: unknown;
} | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as { model?: unknown; usage?: unknown };
  if (typeof candidate.usage !== "object" || candidate.usage === null) return null;
  const usage = candidate.usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  return {
    model: candidate.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}

async function recordResponse(
  state: LedgerState,
  ordinal: number,
  response: Response,
): Promise<void> {
  const requestId = requestIdOf(response);
  if (!response.ok) {
    latch(state, ordinal, `http_${response.status}`, requestId);
    return;
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    latch(state, ordinal, "malformed_response", requestId);
    throw new Error("paid V1 response usage was malformed; run stopped");
  }
  const fields = responseFields(body);
  if (fields === null) {
    latch(state, ordinal, "malformed_usage", requestId);
    throw new Error("paid V1 response model or usage was invalid; run stopped");
  }
  const { inputTokens, outputTokens } = fields;
  const usageIsValid = validUsage(inputTokens, outputTokens);
  if (fields.model !== PAID_MODEL || !usageIsValid) {
    latch(
      state,
      ordinal,
      fields.model === PAID_MODEL ? "malformed_usage" : "model_mismatch",
      requestId,
    );
    throw new Error("paid V1 response model or usage was invalid; run stopped");
  }
  state.reportedInputTokens += Number(inputTokens);
  append(state, {
    ordinal,
    timestamp: new Date().toISOString(),
    status: "completed",
    request_id: requestId,
    model: PAID_MODEL,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    input_cost_usd: Number(inputTokens) * INPUT_USD_PER_TOKEN,
  });
}

function openLedger(path: string): number {
  if (!isAbsolute(path)) throw new Error("paid ledger path must be absolute");
  try {
    return openSync(path, "wx", 0o600);
  } catch {
    throw new Error("paid ledger already exists or cannot be created; restart refused");
  }
}

export function createPaidAttemptGuard(
  ledgerPath: string,
  underlyingFetch: JevFetch,
  maxAttempts = MAX_PAID_ATTEMPTS,
): PaidAttemptGuard {
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_PAID_ATTEMPTS
  ) {
    throw new Error(`paid V1 max attempts must be 1-${MAX_PAID_ATTEMPTS}`);
  }
  const state: LedgerState = {
    fd: openLedger(ledgerPath),
    attempts: 0,
    stopped: false,
    reportedInputTokens: 0,
  };
  let closed = false;
  const guardedFetch: JevFetch = async (input, init) => {
    const ordinal = reserve(state, maxAttempts);
    let response: Response;
    try {
      response = await underlyingFetch(input, init);
    } catch {
      latch(state, ordinal, "transport_failure", null);
      throw new Error(
        "paid V1 transport failed; attempt remains reserved and run stopped",
      );
    }
    await recordResponse(state, ordinal, response);
    return response;
  };
  return {
    fetch: guardedFetch,
    totals: () => ({
      attempts: state.attempts,
      stopped: state.stopped,
      reportedInputTokens: state.reportedInputTokens,
      actualReportedUsd: state.reportedInputTokens * INPUT_USD_PER_TOKEN,
      reservedMaximumUsd: state.attempts * RESERVED_USD_PER_ATTEMPT,
    }),
    close: () => {
      if (closed) return;
      closed = true;
      fsyncSync(state.fd);
      closeSync(state.fd);
    },
  };
}
