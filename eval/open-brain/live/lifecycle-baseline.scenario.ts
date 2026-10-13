import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { parseServerConfig, type ServerConfig } from "../../../server/config.ts";
import { startServer, type StartedServer } from "../../../server/main.ts";
import { runLightSweep } from "../../../server/maintenance/dream-light.ts";
import type { SingleWorkerHealth } from "../../../server/transport/index.ts";
import {
  createMcpCaller,
  OpenBrainLiveClient,
  type OpenBrainToolCaller,
} from "./transport.ts";

interface Fixture {
  schema: string;
  primary_namespace: string;
  negative_namespace: string;
  query: string;
  durable_text: string;
  negative_text: string;
  raw_turn_text: string;
  noise_text: string;
  sessions: [string, string];
  occurred_at: [string, string];
  turn_uuids: [string, string, string];
}

const FIXTURE_URL = new URL("../fixtures/lifecycle-baseline-v1.json", import.meta.url);
const TEST_URL = new URL(import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;
const sdkPackage = JSON.parse(
  readFileSync(
    new URL(
      "../../../node_modules/@modelcontextprotocol/sdk/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { name: string; version: string };
const databaseUrl = requireTestDatabaseUrl();
const databaseName = new URL(databaseUrl).pathname.slice(1);
assert.match(
  databaseName,
  /^ob_isolated_/,
  "lifecycle_requires_isolated_harness_database",
);
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const token = `lifecycle-admin-${process.pid}`;
const logger = pino({ level: "silent" });
const pool = new Pool({ connectionString: databaseUrl });
let started: StartedServer | undefined;
let primaryCaller: OpenBrainToolCaller | undefined;
let negativeCaller: OpenBrainToolCaller | undefined;
let primary: OpenBrainLiveClient | undefined;
let negative: OpenBrainLiveClient | undefined;
let baseUrl = "";
let serviceRevision = "";

function sha256(url: URL): string {
  return createHash("sha256").update(readFileSync(url)).digest("hex");
}

function serverConfig(): ServerConfig {
  const url = new URL(databaseUrl);
  const parsed = parseServerConfig(
    {
      DB_HOST: url.hostname,
      DB_PORT: url.port || "5432",
      DB_NAME: databaseName,
      DB_USER: decodeURIComponent(url.username) || "postgres",
      ...(url.password ? { DB_PASSWORD: decodeURIComponent(url.password) } : {}),
      LOG_FILE: "logs/lifecycle-baseline-test.log",
      OPEN_BRAIN_SERVER_IP: "192.0.2.142",
      OPENBRAIN_MIGRATIONS_DIR: "server/db/migrations",
      AUTH_TOKEN_ADMIN: token,
    },
    sourceRevision,
  );
  if (!parsed.ok) throw new Error("invalid lifecycle test server config");
  return parsed.config;
}

async function ingestTurns(): Promise<void> {
  assert(primaryCaller);
  const turns = [
    {
      turn_uuid: fixture.turn_uuids[0],
      session_ref: fixture.sessions[0],
      turn_index: 0,
      role: "user",
      is_human_prompt: true,
      content: fixture.raw_turn_text,
      runtime: "lifecycle-baseline",
      occurred_at: fixture.occurred_at[0],
    },
    {
      turn_uuid: fixture.turn_uuids[1],
      session_ref: fixture.sessions[1],
      turn_index: 0,
      role: "user",
      is_human_prompt: true,
      content: fixture.raw_turn_text,
      runtime: "lifecycle-baseline",
      occurred_at: fixture.occurred_at[1],
    },
    {
      turn_uuid: fixture.turn_uuids[2],
      session_ref: fixture.sessions[0],
      turn_index: 1,
      role: "tool",
      content: fixture.noise_text,
      runtime: "lifecycle-baseline",
      occurred_at: fixture.occurred_at[1],
    },
  ];
  const result = await primaryCaller.callTool("ingest_raw_turn", { turns });
  assert.equal(result.isError, false);
  const body = JSON.parse(result.data) as { ingested: number; filtered: number };
  assert.deepEqual(body, { ...body, ingested: 2, filtered: 1 });
}

before(async () => {
  assert.equal(fixture.schema, "openbrain.lifecycle_baseline.fixture.v1");
  assert.equal(fixture.sessions.length, 2);
  assert.equal(fixture.turn_uuids.length, 3);
  started = await startServer({
    config: serverConfig(),
    port: 0,
    bindHost: "127.0.0.1",
    logger,
    allowedOrigins: [],
  });
  baseUrl = `http://127.0.0.1:${started.port}`;
  const response = await fetch(`${baseUrl}/health`);
  const health = (await response.json()) as SingleWorkerHealth;
  assert.equal(health.database.connected, true);
  assert.equal(health.revision, sourceRevision);
  serviceRevision = health.revision;
  primaryCaller = await createMcpCaller({
    baseUrl,
    token,
    namespace: fixture.primary_namespace,
    timeoutMs: 10_000,
  });
  negativeCaller = await createMcpCaller({
    baseUrl,
    token,
    namespace: fixture.negative_namespace,
    timeoutMs: 10_000,
  });
  primary = new OpenBrainLiveClient(primaryCaller);
  negative = new OpenBrainLiveClient(negativeCaller);
});

after(async () => {
  const cleanup = await Promise.allSettled([
    primaryCaller?.close() ?? Promise.resolve(),
    negativeCaller?.close() ?? Promise.resolve(),
    started?.shutdown() ?? Promise.resolve(),
    pool.end(),
  ]);
  const rejected = cleanup.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 0, `lifecycle cleanup failures: ${rejected.length}`);
});

async function captureAndAssertBefore(): Promise<{
  capturedId: string;
  negativeId: string;
}> {
  assert(primary && negative);
  assert.equal(fixture.raw_turn_text, fixture.durable_text);
  const captured = await primary.logMemory({
    table: "thoughts",
    content: fixture.durable_text,
    tags: ["lifecycle-baseline"],
    namespace: fixture.primary_namespace,
  });
  const negativeCaptured = await negative.logMemory({
    table: "thoughts",
    content: fixture.negative_text,
    tags: ["lifecycle-negative"],
    namespace: fixture.negative_namespace,
  });
  assert.notEqual(captured.id, negativeCaptured.id);

  const beforeHits = await primary.search({
    query: fixture.query,
    namespace: fixture.primary_namespace,
    limit: 20,
    searchMode: "keyword",
  });
  assert(beforeHits.some((hit) => hit.id === captured.id));
  assert(!beforeHits.some((hit) => hit.id === negativeCaptured.id));
  const readback = await pool.query<{ content: string }>(
    "SELECT content FROM thoughts WHERE id = $1 AND namespace = $2",
    [captured.id, fixture.primary_namespace],
  );
  assert.equal(readback.rows[0]?.content, fixture.durable_text);
  const denial = await primary.attemptRead({
    query: fixture.query,
    namespace: fixture.negative_namespace,
    limit: 20,
    searchMode: "keyword",
  });
  assert.deepEqual(denial, { denied: true, hitCount: 0 });
  return { capturedId: captured.id, negativeId: negativeCaptured.id };
}

async function maintainAndAssertPersistence(): Promise<void> {
  await ingestTurns();
  const firstSweep = await runLightSweep({ pool, logger, batchSize: 20 });
  const occurrence = await pool.query<{
    occurrence_count: number;
    session_count: number;
    sample_content: string;
  }>(
    `SELECT occurrence_count, session_count, sample_content
       FROM content_occurrences
      WHERE namespace = $1 AND sample_content = $2`,
    [fixture.primary_namespace, fixture.raw_turn_text],
  );
  assert.deepEqual(
    occurrence.rows,
    [
      {
        occurrence_count: 2,
        session_count: 2,
        sample_content: fixture.raw_turn_text,
      },
    ],
    "persisted maintenance occurrence row must exist",
  );
  assert.equal(firstSweep.scanned, 2);
  assert.equal(firstSweep.created + firstSweep.updated, 2);
  const rawState = await pool.query<{ turn_uuid: string; swept: boolean }>(
    `SELECT turn_uuid, light_swept_at IS NOT NULL AS swept
       FROM ob_raw_turns WHERE namespace = $1 ORDER BY turn_uuid`,
    [fixture.primary_namespace],
  );
  assert.deepEqual(rawState.rows, [
    { turn_uuid: fixture.turn_uuids[0], swept: true },
    { turn_uuid: fixture.turn_uuids[1], swept: true },
  ]);
  assert.equal(
    rawState.rows.some((row) => row.turn_uuid === fixture.turn_uuids[2]),
    false,
  );

  const secondSweep = await runLightSweep({ pool, logger, batchSize: 20 });
  assert.deepEqual(secondSweep, {
    scanned: 0,
    skipped_noise: 0,
    created: 0,
    updated: 0,
    corroborated: 0,
  });
  const afterOccurrence = await pool.query(
    `SELECT occurrence_count, session_count, sample_content
       FROM content_occurrences
      WHERE namespace = $1 AND sample_content = $2`,
    [fixture.primary_namespace, fixture.raw_turn_text],
  );
  assert.deepEqual(afterOccurrence.rows, occurrence.rows);
}

async function assertAfterAndEmitReceipt(ids: {
  capturedId: string;
  negativeId: string;
}): Promise<void> {
  assert(primary);
  const afterHits = await primary.search({
    query: fixture.query,
    namespace: fixture.primary_namespace,
    limit: 20,
    searchMode: "keyword",
  });
  assert(afterHits.some((hit) => hit.id === ids.capturedId));
  assert(!afterHits.some((hit) => hit.id === ids.negativeId));
  const readback = await pool.query<{ content: string }>(
    "SELECT content FROM thoughts WHERE id = $1 AND namespace = $2",
    [ids.capturedId, fixture.primary_namespace],
  );
  assert.equal(readback.rows[0]?.content, fixture.durable_text);

  const runtime = process.versions.bun
    ? { runtime_name: "bun", runtime_version: process.versions.bun }
    : { runtime_name: "node", runtime_version: process.version };
  const receipt = {
    schema: "openbrain.lifecycle_baseline.v1",
    source_revision: sourceRevision,
    fixture_sha256: sha256(FIXTURE_URL),
    subject_sha256: sha256(TEST_URL),
    run_id: randomUUID(),
    database_name: databaseName,
    service_revision: serviceRevision,
    clients: { sdk: `${sdkPackage.name}@${sdkPackage.version}`, harness: "1.0.0" },
    ...runtime,
    search_mode: "keyword",
    maintenance_stage: "dream.light",
    checks: {
      capture: true,
      retrieve_before: true,
      maintenance_persisted: true,
      repeat_sweep_idempotent: true,
      retrieve_after: true,
      namespace_isolation: true,
    },
  };
  process.stdout.write(`PHASE2_BASELINE_RECEIPT:${JSON.stringify(receipt)}\n`);
}

void test("captured subject survives real DREAM Light maintenance", async () => {
  const ids = await captureAndAssertBefore();
  await maintainAndAssertPersistence();
  await assertAfterAndEmitReceipt(ids);
});
