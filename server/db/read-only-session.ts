/**
 * A deadline-bounded `READ ONLY` session on one pooled client (issue 1209).
 *
 * `./transaction.ts` owns the ordinary unit of work: connect, BEGIN, COMMIT,
 * ROLLBACK, release. It deliberately cannot express what a latency-bounded
 * reader needs -- a connect that gives up when the caller's budget is spent, a
 * `READ ONLY` transaction, a per-statement timeout recomputed from what is
 * left, and a release the caller drives. Those are pool-lifecycle mechanics, and
 * `_plans/463-server-rewrite-charter.md:111` puts pool lifecycle and
 * transactions in server/db, so they live here rather than in the tool that
 * reads through them (`server/tools/context-pack-durable-lane.ts`).
 *
 * The mechanics moved verbatim from that tool: the same deadline arithmetic, the
 * same `BEGIN READ ONLY` plus `set_config('statement_timeout', ...)` opening,
 * the same release-with-error on an unsafe client, and the same error text.
 */
import type { Pool, PoolClient, QueryConfig } from "pg";

/** The rows a session statement projects. */
export type ReadOnlyRow = Record<string, unknown>;

/** What the caller drives: statements, then exactly one of commit/rollback, then release. */
export interface ReadOnlySession {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: ReadOnlyRow[] }>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  release: () => void;
}

/** Everything opening a session needs, as one object argument (D3). */
export interface OpenReadOnlySessionInput {
  /** The pool a client is checked out of for this read. */
  pool: Pool;
  /** Total milliseconds the read may take, measured from `startedAt`. */
  maxLatencyMs: number;
  /**
   * Called when a client arrives after the deadline already fired and is
   * released instead of used, so an abandoned checkout is never silent.
   */
  onLateArrival?: (error: unknown) => void;
}

/**
 * Milliseconds left in the caller's latency budget, or a throw when it is spent.
 *
 * Throwing rather than clamping to zero is deliberate: a zero-length query
 * timeout is not "run instantly", it is "run forever" in most drivers, which is
 * precisely the failure a latency budget exists to prevent.
 */
function remainingLatencyMs(startedAt: number, maxLatencyMs: number): number {
  const remainingMs = Math.floor(maxLatencyMs - (performance.now() - startedAt));
  if (remainingMs < 1) {
    throw new Error("durable lane context latency budget exhausted");
  }
  return remainingMs;
}

/**
 * Acquire a pooled client without letting pool exhaustion silently eat the
 * caller's whole latency budget. If the timer wins, the late-arriving client is
 * released rather than leaked -- an abandoned checkout is how a pool starves.
 */
async function acquirePoolClient(
  input: OpenReadOnlySessionInput,
  startedAt: number,
): Promise<PoolClient> {
  const remainingMs = remainingLatencyMs(startedAt, input.maxLatencyMs);
  const connectPromise = input.pool.connect();

  return await new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error("durable lane context latency budget exhausted"));
    }, remainingMs);

    void connectPromise
      .then(
        (client) => {
          if (settled) {
            client.release();
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve(client);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        },
      )
      .catch((error: unknown) => {
        input.onLateArrival?.(error);
        return undefined;
      });
  });
}

type TimedQueryConfig = QueryConfig<unknown[]> & { query_timeout: number };

async function queryWithinLatencyBudget(options: {
  client: PoolClient;
  startedAt: number;
  maxLatencyMs: number;
  text: string;
  values?: unknown[];
}): Promise<{ rows: ReadOnlyRow[] }> {
  const { client, startedAt, maxLatencyMs, text, values } = options;
  const config: TimedQueryConfig = {
    text,
    values,
    query_timeout: remainingLatencyMs(startedAt, maxLatencyMs),
  };
  const result = await client.query(config);
  return { rows: result.rows as ReadOnlyRow[] };
}

/**
 * Take a dedicated client inside a `READ ONLY` transaction carrying a
 * server-side `statement_timeout`, so a query that outlives the budget is
 * cancelled by Postgres itself rather than merely abandoned by the driver while
 * the backend keeps burning CPU.
 *
 * A client that errored is released WITH the error, which destroys it instead of
 * returning a connection in an unknown transaction state to the pool.
 */
export async function openReadOnlySession(
  input: OpenReadOnlySessionInput,
): Promise<ReadOnlySession> {
  const { maxLatencyMs } = input;
  const startedAt = performance.now();
  const client = await acquirePoolClient(input, startedAt);
  let transactionOpen = false;
  let released = false;
  let unsafeError: Error | undefined;
  const markUnsafe = (error: unknown) => {
    unsafeError =
      error instanceof Error
        ? error
        : new Error("durable lane context client is unsafe");
  };
  const release = () => {
    if (released) return;
    released = true;
    client.release(unsafeError);
  };
  const query = async (sql: string, params?: unknown[]) => {
    try {
      return await queryWithinLatencyBudget({
        client,
        startedAt,
        maxLatencyMs,
        text: sql,
        values: params,
      });
    } catch (error) {
      markUnsafe(error);
      throw error;
    }
  };
  try {
    await query("BEGIN READ ONLY");
    transactionOpen = true;
    await query("SELECT set_config('statement_timeout', $1, true)", [
      `${remainingLatencyMs(startedAt, maxLatencyMs)}ms`,
    ]);
  } catch (error) {
    markUnsafe(error);
    release();
    throw error;
  }

  return {
    query: async (sql, params) => await query(sql, params),
    commit: async () => {
      await query("COMMIT");
      transactionOpen = false;
    },
    rollback: async () => {
      if (!transactionOpen || unsafeError) return;
      await query("ROLLBACK");
      transactionOpen = false;
    },
    release,
  };
}
