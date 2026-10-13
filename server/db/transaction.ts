/**
 * The one transaction owner for this repo (issue 1209).
 *
 * `_plans/463-server-rewrite-charter.md:111` assigns server/db "pool lifecycle,
 * transactions, repositories, append-only migrations", and `./index.ts` declares
 * the same boundary -- but until this module there was no transaction code in
 * the tier at all. Four maintenance modules each hand-rolled the identical
 * connect/BEGIN/COMMIT/ROLLBACK-with-warn sequence:
 *
 *   server/maintenance/dream-light.ts
 *   server/maintenance/distill-persist.ts
 *   server/maintenance/distill-exchange-run.ts
 *   server/maintenance/graph-derivation-handler.ts
 *
 * This module exists so those four sites can become calls in later lanes and the
 * BEGIN/COMMIT/ROLLBACK text leaves the maintenance tier. It adds no behavior
 * they did not already have; the rollback-failure path is theirs, lifted here so
 * one implementation is the one that gets reviewed and tested. It since carries
 * three OPTIONAL additions -- `readOnly`, `statementTimeoutMs`, and the `abort`
 * control -- so the two tools modules whose transactions are not plain
 * BEGIN/COMMIT (`server/tools/find-duplicates.ts` and
 * `server/tools/update-entry.ts`) can port onto it too; a call that passes none
 * of them behaves exactly as before.
 */
import type pg from "pg";

/**
 * The read-only slice of a pool a repository statement actually needs.
 *
 * Both a `pg.Pool` and a `pg.PoolClient` satisfy it, which is what lets a
 * repository function run inside or outside a transaction unchanged.
 */
export type QuerySurface = Pick<pg.Pool, "query">;

/**
 * The second argument handed to `run`, for work that has to end the transaction
 * early and still produce a value (issue 1209).
 *
 * `server/tools/update-entry.ts` is why this exists: it issues a
 * mid-transaction ROLLBACK and RETURNS an MCP error envelope to its caller
 * rather than throwing, so the plain rollback-on-throw path cannot express it.
 * `run` may ignore this parameter entirely -- a one-parameter `run` is
 * assignable, which is what keeps every pre-existing caller compiling.
 */
export interface TransactionControl<T> {
  /**
   * Rolls the transaction back and makes `withTransaction` RETURN `value`.
   *
   * Never returns: it throws a module-private sentinel that `withTransaction`
   * recognises. Nothing after the call in `run` executes, and the value is not
   * an error -- it is this unit of work's ordinary result.
   */
  abort(value: T): never;
}

/**
 * Raised by `TransactionControl.abort` and caught by `withTransaction` alone.
 *
 * Module-private on purpose: nothing outside this file can construct one, so a
 * value returned through the abort path is always one `run` chose to return.
 */
class TransactionAbort<T> extends Error {
  readonly value: T;

  constructor(value: T) {
    super("transaction aborted by run()");
    this.name = "TransactionAbort";
    this.value = value;
  }
}

/** One object argument, per the repo's D3 call shape. */
export interface TransactionInput<T> {
  /** The pool a client is checked out of, and returned to, for this unit of work. */
  pool: pg.Pool;
  /**
   * The work itself. Anything it throws rolls the transaction back.
   *
   * The second parameter is optional at the call site; see `TransactionControl`.
   */
  run: (tx: pg.PoolClient, control: TransactionControl<T>) => Promise<T>;
  /**
   * Opens the transaction with `BEGIN READ ONLY` instead of `BEGIN`.
   *
   * `server/tools/find-duplicates.ts` needs it: the tool reports duplicate
   * pairs and writes nothing, and the READ ONLY transaction is half of the
   * measured #485 safety net recorded in
   * `docs/decisions/1214-find-duplicates-namespace-bounded-self-join.md`.
   */
  readOnly?: boolean;
  /**
   * Runs `SELECT set_config('statement_timeout', $1, true)` immediately after
   * the opening statement, with `${statementTimeoutMs}ms` as the parameter.
   *
   * The third `set_config` argument is `true`, so the setting is
   * transaction-local and COMMIT or ROLLBACK clears it -- the pooled client
   * goes back unaltered. This is the other half of the #485 net
   * `server/tools/find-duplicates.ts` carries: a pathological namespace cannot
   * hold a pooled connection open indefinitely.
   */
  statementTimeoutMs?: number;
  /**
   * Called when the ROLLBACK itself fails, with the rollback error.
   *
   * The original error still propagates either way; this hook exists so a failed
   * rollback is not silent, which is what each of the four hand-rolled sites
   * used a `.catch(warn)` for. It applies to the `abort` path too: an aborted
   * transaction still rolls back, and a failure there is still reported.
   */
  onRollbackFailure?: (error: unknown) => void;
}

/**
 * Runs `run` inside a single BEGIN/COMMIT transaction on one pooled client.
 *
 * On success the transaction commits and `run`'s value is returned. On throw the
 * transaction rolls back and the ORIGINAL error is rethrown -- never the
 * rollback's, which would replace the diagnosis with its own aftermath. If `run`
 * called `control.abort(value)` the transaction rolls back and `value` is
 * RETURNED rather than anything being thrown. The client is released in every
 * path.
 */
export async function withTransaction<T>(input: TransactionInput<T>): Promise<T> {
  const client = await input.pool.connect();
  const control: TransactionControl<T> = {
    abort(value: T): never {
      throw new TransactionAbort(value);
    },
  };
  try {
    await client.query(input.readOnly === true ? "BEGIN READ ONLY" : "BEGIN");
    if (input.statementTimeoutMs !== undefined) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${input.statementTimeoutMs}ms`,
      ]);
    }
    const result = await input.run(client, control);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      input.onRollbackFailure?.(rollbackError);
    }
    if (error instanceof TransactionAbort) {
      return error.value as T;
    }
    throw error;
  } finally {
    client.release();
  }
}
