/**
 * The orchestration layer: schedule rounds, fold results, persist, record.
 *
 * This is the only module in the monitor that knows about all the others. The
 * checker does IO, the evaluator decides, the store persists, the database
 * records -- and this composes them. Keeping composition in one place is what
 * lets each of the others be tested without the rest.
 */

import type { Logger } from "pino";

import type { Settings } from "../../config.ts";
import type { CheckTarget, TargetState } from "../../models/check.ts";
import type { Database } from "../../db/database.ts";
import { withLogContext } from "../../utils/logging.ts";
import { checkOnce } from "./checker.ts";
import { applyResult, initialState } from "./evaluator.ts";
import { StateStore } from "./store.ts";

/** Everything the service needs, injected rather than constructed. */
export interface MonitorDeps {
  settings: Settings;
  logger: Logger;
  store: StateStore;
  /** Omit to run without history. The monitor is useful either way. */
  database?: Database;
}

/**
 * Runs check rounds on an interval until stopped.
 *
 * Dependencies are injected, never constructed here: that is what makes the
 * whole loop testable against an in-memory store and a fake target, with no
 * network and no timer.
 */
export class MonitorService {
  readonly #deps: MonitorDeps;
  #states = new Map<string, TargetState>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(deps: MonitorDeps) {
    this.#deps = deps;
  }

  /** Current state for every known target. A copy -- callers cannot mutate it. */
  snapshot(): TargetState[] {
    return [...this.#states.values()].map((state) => ({ ...state }));
  }

  /** Load persisted state, seeding any target that has none. */
  hydrate(): void {
    for (const state of this.#deps.store.load()) {
      this.#states.set(state.targetName, state);
    }
    for (const target of this.#deps.settings.monitor.targets) {
      if (!this.#states.has(target.name)) {
        this.#states.set(target.name, initialState(target.name));
      }
    }
    this.#deps.logger.info({ targets: this.#states.size }, "monitor hydrated");
  }

  /**
   * Run every target once, concurrently.
   *
   * `Promise.all` rather than a sequential loop: with ten targets at a
   * five-second timeout, sequential worst-case is fifty seconds, which would
   * overrun a sixty-second interval and quietly start overlapping rounds.
   *
   * @returns The states after this round.
   */
  async runRound(): Promise<TargetState[]> {
    const { settings, logger, store, database } = this.#deps;

    const results = await Promise.all(
      settings.monitor.targets.map(async (target: CheckTarget) =>
        // Each target gets its own correlation id, so one target's lines can be
        // followed through the log without the others interleaving.
        withLogContext(
          { correlationId: `${target.name}-${Date.now().toString(36)}` },
          async () => checkOnce(target, logger),
        ),
      ),
    );

    for (const [index, result] of results.entries()) {
      const target = settings.monitor.targets[index];
      if (target === undefined) continue;

      const previous = this.#states.get(target.name) ?? initialState(target.name);
      this.#states.set(target.name, applyResult(previous, target, result));

      database?.record({
        targetName: result.targetName,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
        error: result.error,
        recordedAt: result.recordedAt,
      });
    }

    store.save(this.snapshot());
    return this.snapshot();
  }

  /** Begin the interval loop. Idempotent. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const intervalMs = this.#deps.settings.monitor.intervalSeconds * 1_000;

    const tick = (): void => {
      // The loop must never die from one bad round: a rejected promise here
      // would become an unhandled rejection and take the process with it.
      void this.runRound().catch((error: unknown) => {
        this.#deps.logger.error(
          { err: error instanceof Error ? error : new Error(String(error)) },
          "round failed",
        );
      });
    };

    tick();
    this.#timer = setInterval(tick, intervalMs);
    this.#deps.logger.info({ interval_ms: intervalMs }, "monitor started");
  }

  /** Stop the loop. Safe to call when not running. */
  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#running = false;
    this.#deps.logger.info("monitor stopped");
  }
}
