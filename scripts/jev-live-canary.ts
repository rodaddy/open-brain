import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import pino from "pino";
import {
  buildJevBatchPlan,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MAX_REQUEST_BYTES,
  DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  DEFAULT_JEV_MODEL,
  executeJevBatchPlan,
  REM_CLASSIFIER_SET,
  type JevConfig,
  type JevFetch,
} from "../server/integrations/jev.ts";
import {
  generateEmbedding,
  setEmbeddingSettingsReader,
} from "../server/embedding/provider.ts";
import { executeSearch } from "../server/tools/search-engine.ts";

const execFileAsync = promisify(execFile);
const INPUT_USD_PER_MILLION_TOKENS = 0.042;
const MAX_PROVIDER_CALLS = 4;
const MAX_ESTIMATED_INPUT_USD = 0.05;
const NAMESPACE = "rico";
const SEARCH_QUERY =
  "What rules govern Open Brain dream stage promotion and operator approval?";

export interface ProviderCallReceipt {
  status: number;
  requestBytes: number;
  questionCount: number;
  responseAnswerCount: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

interface RawTurn {
  id: string;
  content: string;
  content_hash: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secretFromCredentialPayload(stdout: string): string {
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  const result = (payload.result ?? payload) as Record<string, unknown>;
  const fields = result.fields as Record<string, unknown> | undefined;
  const nested = fields?.api_key;
  if (typeof nested === "string" && nested.length > 0) return nested;
  const direct = result.api_key;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const fieldNames = Object.keys(fields ?? {}).sort();
  throw new Error(
    `TypeSafe credential response did not contain api_key; available fields: ${fieldNames.join(",") || "none"}`,
  );
}

async function getTypeSafeKey(): Promise<string> {
  // TYPESAFE_KEY_COMMAND names a command that prints a credential JSON
  // payload ({"fields":{"api_key":...}} or {"api_key":...}) on stdout.
  const direct = process.env.TYPESAFE_API_KEY;
  if (direct) return direct;
  const command = process.env.TYPESAFE_KEY_COMMAND;
  if (!command) throw new Error("set TYPESAFE_API_KEY or TYPESAFE_KEY_COMMAND");
  const [file, ...args] = command.split(" ");
  const { stdout } = await execFileAsync(file, args);
  return secretFromCredentialPayload(stdout);
}

function usageNumber(value: unknown, snake: string, camel: string): number {
  if (!value || typeof value !== "object") return 0;
  const usage = value as Record<string, unknown>;
  const found = usage[snake] ?? usage[camel];
  return typeof found === "number" ? found : 0;
}

function trackedFetch(receipts: ProviderCallReceipt[]): JevFetch {
  return async (input, init) => {
    if (receipts.length >= MAX_PROVIDER_CALLS)
      throw new Error("provider call ceiling reached");
    const body = typeof init?.body === "string" ? init.body : "";
    const request = JSON.parse(body) as { questions?: Record<string, unknown> };
    const response = await fetch(input, init);
    const responseText = await response.text();
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    const answers = parsed.answers as Record<string, unknown> | undefined;
    const usage = parsed.usage;
    receipts.push({
      status: response.status,
      requestBytes: new TextEncoder().encode(body).byteLength,
      questionCount: Object.keys(request.questions ?? {}).length,
      responseAnswerCount: Object.keys(answers ?? {}).length,
      model: typeof parsed.model === "string" ? parsed.model : null,
      inputTokens: usageNumber(usage, "input_tokens", "inputTokens"),
      outputTokens: usageNumber(usage, "output_tokens", "outputTokens"),
    });
    return new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

interface CanaryReceiptInput {
  config: JevConfig;
  providerCalls: ProviderCallReceipt[];
  incomingRows: RawTurn[];
  incomingPlan: ReturnType<typeof buildJevBatchPlan>;
  incomingResult: Awaited<ReturnType<typeof executeJevBatchPlan>>;
  outgoingRows: Awaited<ReturnType<typeof executeSearch>>;
  outgoingCalls: ProviderCallReceipt[];
  outgoingEvaluatedCandidateCount: number;
  outgoingFallbackCount: number;
  validMapping: boolean;
  outgoingValidMapping: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedInputUsd: number;
}

function buildReceipt(input: CanaryReceiptInput) {
  const {
    config,
    providerCalls,
    incomingRows,
    incomingPlan,
    incomingResult,
    outgoingRows,
    outgoingCalls,
    outgoingEvaluatedCandidateCount,
    outgoingFallbackCount,
    validMapping,
    outgoingValidMapping,
    totalInputTokens,
    totalOutputTokens,
    estimatedInputUsd,
  } = input;
  return {
    canary: "jev-live-canary-v1",
    data_mode:
      "read-only real local Open Brain rows; provider payloads retained only in process memory",
    namespace: NAMESPACE,
    provider: {
      requested_model: config.model,
      served_models: [...new Set(providerCalls.map(({ model }) => model))],
      call_count: providerCalls.length,
      retry_count: 0,
      question_count: providerCalls.reduce((sum, call) => sum + call.questionCount, 0),
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      estimated_input_usd: estimatedInputUsd,
      calls: providerCalls,
    },
    incoming: {
      source_table: "ob_raw_turns",
      record_count: incomingRows.length,
      batch_count: incomingPlan.batches.length,
      question_count: incomingPlan.batches.reduce(
        (sum, batch) => sum + Object.keys(batch.questions).length,
        0,
      ),
      valid_mapping: validMapping,
      fallback: false,
      records: incomingRows.map((row) => {
        const answers = incomingResult.answers.get(row.id);
        return {
          id: row.id,
          content_hash: row.content_hash || digest(row.content),
          label: answers?.label?.type === "choice" ? answers.label.choice : null,
          score: answers?.score?.type === "choice" ? answers.score.choice : null,
        };
      }),
    },
    outgoing: {
      query_sha256: digest(SEARCH_QUERY),
      requested_pool_size: 8,
      evaluated_candidate_count: outgoingEvaluatedCandidateCount,
      result_count: outgoingRows.length,
      result_ids: outgoingRows.map((row) => `${row.source_type}:${row.id}`),
      valid_mapping: outgoingValidMapping,
      fallback: outgoingFallbackCount > 0,
      provider_calls: outgoingCalls,
    },
  };
}

export function evaluateOutgoingCanary(
  calls: readonly ProviderCallReceipt[],
  fallbackCount: number,
): { validMapping: boolean; evaluatedCandidateCount: number } {
  const evaluatedCandidateCount = calls.reduce(
    (sum, call) => sum + call.questionCount,
    0,
  );
  return {
    evaluatedCandidateCount,
    validMapping:
      calls.length > 0 &&
      fallbackCount === 0 &&
      calls.every(
        (call) =>
          call.status >= 200 &&
          call.status < 300 &&
          call.questionCount > 0 &&
          call.questionCount === call.responseAnswerCount,
      ),
  };
}

export function createCanaryLogger(): {
  logger: pino.Logger;
  fallbackCount: () => number;
} {
  let fallbacks = 0;
  const logger = pino(
    {
      level: "warn",
      hooks: {
        logMethod(args, method) {
          if (args.at(-1) === "jev_rerank_failed_fallback_rrf") fallbacks++;
          method.apply(this, args);
        },
      },
    },
    { write: () => true },
  );
  return { logger, fallbackCount: () => fallbacks };
}

function providerUsage(calls: readonly ProviderCallReceipt[]) {
  const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const outputTokens = calls.reduce((sum, call) => sum + call.outputTokens, 0);
  return {
    inputTokens,
    outputTokens,
    estimatedInputUsd: (inputTokens / 1_000_000) * INPUT_USD_PER_MILLION_TOKENS,
  };
}

function configureEmbedding(): void {
  setEmbeddingSettingsReader(() => ({
    baseUrl: required("EMBEDDING_BASE_URL"),
    ...(process.env.EMBEDDING_API_KEY ? { apiKey: process.env.EMBEDDING_API_KEY } : {}),
    model: required("EMBEDDING_MODEL"),
    dimensions: 768,
    timeoutMs: 8_000,
    watchdog: { failureThreshold: 2, cooldownMs: 300_000 },
  }));
}

function createReadOnlyPool(): pg.Pool {
  return new pg.Pool({
    host: required("PGHOST"),
    port: Number(process.env.PGPORT ?? "5432"),
    database: required("PGDATABASE"),
    user: required("PGUSER"),
    ...(process.env.PGPASSWORD ? { password: process.env.PGPASSWORD } : {}),
    max: 2,
    options: "-c default_transaction_read_only=on",
  });
}

async function main(): Promise<void> {
  const apiKey = await getTypeSafeKey();
  const config: JevConfig = {
    enabled: true,
    apiKey,
    baseUrl: DEFAULT_JEV_BASE_URL,
    model: DEFAULT_JEV_MODEL,
    timeoutMs: 15_000,
    maxRequestBytes: DEFAULT_JEV_MAX_REQUEST_BYTES,
    maxStateQuestionBytes: DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  };
  configureEmbedding();
  const pool = createReadOnlyPool();
  const providerCalls: ProviderCallReceipt[] = [];
  const fetchFn = trackedFetch(providerCalls);
  const fallbackObserver = createCanaryLogger();

  try {
    const incoming = await pool.query<RawTurn>(
      `SELECT id::text, content, content_hash
         FROM ob_raw_turns
        WHERE namespace = $1
          AND role = 'user'
          AND is_human_prompt = true
          AND invalid_at IS NULL
          AND char_length(content) BETWEEN 80 AND 1500
        ORDER BY occurred_at DESC
        LIMIT 4`,
      [NAMESPACE],
    );
    if (incoming.rows.length !== 4)
      throw new Error("expected four real operator records");
    const incomingPlan = buildJevBatchPlan({
      sharedState: { source: "ob_raw_turns", namespace: NAMESPACE, role: "user" },
      records: incoming.rows.map((row) => ({ key: row.id, content: row.content })),
      classifierSet: REM_CLASSIFIER_SET,
      limits: config,
    });
    if (incomingPlan.batches.length !== 1)
      throw new Error("incoming records did not fit one batch");
    const incomingResult = await executeJevBatchPlan(config, incomingPlan, fetchFn);
    const incomingCallCount = providerCalls.length;

    const outgoingRows = await executeSearch(
      {
        pool,
        embedFn: generateEmbedding,
        logger: fallbackObserver.logger,
        jev: { config, fetchFn },
      },
      ["thoughts", "decisions", "session_events"],
      SEARCH_QUERY,
      8,
      "hybrid",
      undefined,
      0,
      NAMESPACE,
      {},
    );

    const {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedInputUsd,
    } = providerUsage(providerCalls);
    if (providerCalls.length > MAX_PROVIDER_CALLS)
      throw new Error("provider call ceiling exceeded");
    if (estimatedInputUsd > MAX_ESTIMATED_INPUT_USD)
      throw new Error("input budget exceeded");
    const validMapping = incoming.rows.every((row) => {
      const answers = incomingResult.answers.get(row.id);
      return answers?.label?.type === "choice" && answers.score?.type === "choice";
    });
    const outgoingCalls = providerCalls.slice(incomingCallCount);
    const outgoingFallbackCount = fallbackObserver.fallbackCount();
    const outgoingEvaluation = evaluateOutgoingCanary(
      outgoingCalls,
      outgoingFallbackCount,
    );
    const outgoingValidMapping = outgoingEvaluation.validMapping;
    const receipt = buildReceipt({
      config,
      providerCalls,
      incomingRows: incoming.rows,
      incomingPlan,
      incomingResult,
      outgoingRows,
      outgoingCalls,
      outgoingEvaluatedCandidateCount: outgoingEvaluation.evaluatedCandidateCount,
      outgoingFallbackCount,
      validMapping,
      outgoingValidMapping,
      totalInputTokens,
      totalOutputTokens,
      estimatedInputUsd,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (!validMapping || !outgoingValidMapping) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) await main();
