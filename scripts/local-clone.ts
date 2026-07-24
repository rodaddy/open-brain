#!/usr/bin/env bun
/**
 * Fail-closed launcher for an explicitly configured local Open Brain clone.
 *
 * This launcher never discovers configuration or mutates PostgreSQL. It first
 * proves the configured database and embedding provider through read-only
 * probes, then either prints one content-free verification receipt or replaces
 * that verification step with a tightly scoped src/index.ts child process.
 */
import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";
import { validateLocalCloneMode } from "../src/local-clone-mode.ts";

export const LOCAL_CLONE_VERIFY_RECEIPT_SCHEMA =
  "openbrain.local_clone_verify_receipt.v1";

const CHILD_ENV_KEYS = [
  "ALLOWED_ORIGINS",
  "AUTH_TOKEN_ADMIN",
  "AUTH_TOKEN_AGENT",
  "AUTH_TOKEN_DISCORD",
  "AUTH_TOKEN_OB_ADMIN",
  "AUTH_TOKEN_PROMOTER",
  "AUTH_TOKEN_READONLY",
  "DB_HOST",
  "DB_NAME",
  "DB_PASSWORD",
  "DB_POOL_MAX",
  "DB_PORT",
  "DB_USER",
  "EMBEDDING_API_KEY",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_DIMENSIONS",
  "EMBEDDING_MODEL",
  "EMBEDDING_TIMEOUT_MS",
  "LOG_FILE",
  "NODE_ENV",
  "OPENBRAIN_LOCAL_CLONE",
  "OPENBRAIN_LOCAL_CLONE_ROOT",
  "OPENBRAIN_RECOVERY_WAL_PATH",
  "OPEN_BRAIN_BIND_HOST",
  "OPEN_BRAIN_MAINTENANCE_ENABLED",
  "OPEN_BRAIN_RUN_MIGRATIONS",
  "OPENBRAIN_TRANSPORT",
  "PORT",
  "QMD_PATH",
  "TZ",
] as const;

type LauncherMode = "verify" | "start";

export interface DatabaseProof {
  database: string;
  user: string;
  serverAddress: string;
  serverPort: number;
  postgresMajor: number;
  transactionReadOnly: boolean;
  pgvectorAvailable: boolean;
  pgvectorInstalled: boolean;
}

export interface EmbeddingProof {
  model: string;
  dimensions: number;
}

export interface DatabaseBoundary {
  prove(env: Record<string, string | undefined>): Promise<DatabaseProof>;
}

export interface EmbeddingBoundary {
  prove(env: Record<string, string | undefined>): Promise<EmbeddingProof>;
}

export interface ChildBoundary {
  spawn(env: Record<string, string>): ChildProcess;
}

export interface LocalCloneLauncherDependencies {
  database: DatabaseBoundary;
  embedding: EmbeddingBoundary;
  child: ChildBoundary;
  writeReceipt(receipt: unknown): void;
  onSignal(signal: NodeJS.Signals, handler: () => void): () => void;
}

interface DatabaseProbeRow {
  database: string;
  user_name: string;
  server_address: string | null;
  server_port: number | string | null;
  server_version: string;
  transaction_read_only: string;
  pgvector_available: boolean;
  pgvector_installed: boolean;
}

function required(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const configured = env[key]?.trim();
  if (!configured) throw new Error(`Local clone launcher requires ${key}`);
  return configured;
}

function configuredPort(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const parsed = Number.parseInt(env[key] ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Local clone launcher requires a valid ${key}`);
  }
  return parsed;
}

export function parseLocalCloneArgs(argv: string[]): LauncherMode {
  if (argv.length === 1 && argv[0] === "--verify") return "verify";
  if (argv.length === 1 && argv[0] === "--start") return "start";
  throw new Error("Usage: bun run scripts/local-clone.ts --verify | --start");
}

export function buildChildEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const configured = env[key];
    if (configured !== undefined) childEnv[key] = configured;
  }
  for (const [key, configured] of Object.entries(env)) {
    if (key.startsWith("AUTH_TOKEN_USER_") && configured !== undefined) {
      childEnv[key] = configured;
    }
  }
  return childEnv;
}

function assertDatabaseProof(
  proof: DatabaseProof,
  env: Record<string, string | undefined>,
): void {
  if (!proof.transactionReadOnly) {
    throw new Error("Local clone database probe was not read-only");
  }
  if (proof.database !== required(env, "DB_NAME")) {
    throw new Error("Local clone database identity does not match DB_NAME");
  }
  if (proof.user !== required(env, "DB_USER")) {
    throw new Error("Local clone database identity does not match DB_USER");
  }
  if (proof.serverAddress !== required(env, "DB_HOST")) {
    throw new Error("Local clone database address does not match DB_HOST");
  }
  if (proof.serverPort !== configuredPort(env, "DB_PORT", 5432)) {
    throw new Error("Local clone database port does not match DB_PORT");
  }
  if (proof.postgresMajor !== 18) {
    throw new Error("Local clone launcher requires PostgreSQL major 18");
  }
  if (!proof.pgvectorAvailable || !proof.pgvectorInstalled) {
    throw new Error(
      "Local clone launcher requires pgvector to be available and installed",
    );
  }
}

function expectedEmbedding(
  env: Record<string, string | undefined>,
): EmbeddingProof {
  const dimensions = Number.parseInt(env.EMBEDDING_DIMENSIONS ?? "768", 10);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      "Local clone launcher requires a valid EMBEDDING_DIMENSIONS",
    );
  }
  return {
    model: env.EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
    dimensions,
  };
}

function assertEmbeddingProof(
  proof: EmbeddingProof,
  env: Record<string, string | undefined>,
): void {
  const expected = expectedEmbedding(env);
  if (proof.model !== expected.model) {
    throw new Error(
      "Local clone embedding provider does not expose EMBEDDING_MODEL",
    );
  }
  if (proof.dimensions !== expected.dimensions) {
    throw new Error(
      "Local clone embedding provider returned an incompatible dimension",
    );
  }
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(128 + (signal === "SIGINT" ? 2 : 15));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function runLocalCloneLauncher(
  mode: LauncherMode,
  env: Record<string, string | undefined>,
  deps: LocalCloneLauncherDependencies,
): Promise<number> {
  const clone = validateLocalCloneMode(env);
  if (!clone.enabled) {
    throw new Error("Local clone launcher requires OPENBRAIN_LOCAL_CLONE=1");
  }

  let database: DatabaseProof;
  try {
    database = await deps.database.prove(env);
  } catch {
    throw new Error("Local clone database preflight failed");
  }
  assertDatabaseProof(database, env);
  let embedding: EmbeddingProof;
  try {
    embedding = await deps.embedding.prove(env);
  } catch {
    throw new Error("Local clone embedding preflight failed");
  }
  assertEmbeddingProof(embedding, env);

  if (mode === "verify") {
    deps.writeReceipt({
      schema: LOCAL_CLONE_VERIFY_RECEIPT_SCHEMA,
      operation: "local_clone_verify",
      status: "verified",
      database: {
        identity_verified: true,
        read_only: true,
        postgres_major: 18,
        pgvector_available: true,
        pgvector_installed: true,
      },
      embedding: {
        model_verified: true,
        dimensions: embedding.dimensions,
        healthy: true,
      },
    });
    return 0;
  }

  let child: ChildProcess;
  try {
    child = deps.child.spawn(buildChildEnvironment(env));
  } catch {
    throw new Error("Local clone runtime failed to start");
  }
  const removeSignalHandlers = (["SIGINT", "SIGTERM"] as const).map((signal) =>
    deps.onSignal(signal, () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }),
  );
  try {
    try {
      return await waitForChild(child);
    } catch {
      throw new Error("Local clone runtime child failed");
    }
  } finally {
    for (const remove of removeSignalHandlers) remove();
  }
}

export const productionDependencies: LocalCloneLauncherDependencies = {
  database: {
    async prove(env): Promise<DatabaseProof> {
      const client = new pg.Client({
        host: required(env, "DB_HOST"),
        port: configuredPort(env, "DB_PORT", 5432),
        database: required(env, "DB_NAME"),
        user: required(env, "DB_USER"),
        password: async () => env.DB_PASSWORD ?? "",
        ssl: false,
        options: "-c default_transaction_read_only=on",
        connectionTimeoutMillis: 5_000,
        statement_timeout: 5_000,
        application_name: "open-brain-local-clone-preflight",
      });
      await client.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const result = await client.query<DatabaseProbeRow>(`
          SELECT
            current_database() AS database,
            current_user AS user_name,
            inet_server_addr()::text AS server_address,
            inet_server_port() AS server_port,
            current_setting('server_version') AS server_version,
            current_setting('transaction_read_only') AS transaction_read_only,
            EXISTS (
              SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
            ) AS pgvector_available,
            EXISTS (
              SELECT 1 FROM pg_extension WHERE extname = 'vector'
            ) AS pgvector_installed
        `);
        const row = result.rows[0];
        if (!row || row.server_address === null || row.server_port === null) {
          throw new Error("Local clone database did not return TCP identity");
        }
        return {
          database: row.database,
          user: row.user_name,
          serverAddress: row.server_address,
          serverPort: Number(row.server_port),
          postgresMajor: Number.parseInt(row.server_version, 10),
          transactionReadOnly: row.transaction_read_only === "on",
          pgvectorAvailable: row.pgvector_available,
          pgvectorInstalled: row.pgvector_installed,
        };
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    },
  },
  embedding: {
    async prove(env): Promise<EmbeddingProof> {
      const baseUrl = required(env, "EMBEDDING_BASE_URL").replace(/\/+$/, "");
      const expected = expectedEmbedding(env);
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      const apiKey = env.EMBEDDING_API_KEY?.trim();
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const modelsResponse = await fetch(`${baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!modelsResponse.ok) {
        throw new Error("Local clone embedding provider health check failed");
      }
      const models = (await modelsResponse.json()) as {
        data?: Array<{ id?: unknown }>;
      };
      if (
        !models.data?.some(
          (model) =>
            typeof model.id === "string" && model.id === expected.model,
        )
      ) {
        throw new Error(
          "Local clone embedding provider does not expose EMBEDDING_MODEL",
        );
      }

      const embeddingResponse = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: expected.model,
          input: "local clone compatibility probe",
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!embeddingResponse.ok) {
        throw new Error("Local clone embedding provider probe failed");
      }
      const payload = (await embeddingResponse.json()) as {
        data?: Array<{ embedding?: unknown }>;
      };
      const vector = payload.data?.[0]?.embedding;
      if (!Array.isArray(vector)) {
        throw new Error("Local clone embedding provider returned no vector");
      }
      return { model: expected.model, dimensions: vector.length };
    },
  },
  child: {
    spawn(env): ChildProcess {
      return spawn(process.execPath, ["run", "src/index.ts"], {
        cwd: process.cwd(),
        env,
        stdio: "inherit",
      });
    },
  },
  writeReceipt(receipt): void {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  },
  onSignal(signal, handler): () => void {
    process.on(signal, handler);
    return () => process.off(signal, handler);
  },
};

if (import.meta.main) {
  try {
    const mode = parseLocalCloneArgs(Bun.argv.slice(2));
    process.exitCode = await runLocalCloneLauncher(
      mode,
      process.env,
      productionDependencies,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Local clone launcher failed",
    );
    process.exitCode = 1;
  }
}
