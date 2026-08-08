/**
 * Gather the counts `/health` needs to judge the raw-capture lane, from the
 * only vantage point a SERVER actually has: arrivals in `ob_raw_turns`.
 *
 * WHY THIS MODULE EXISTS (#652, closing the gap #648 left open by name).
 * PR #648 merged the verdict half of capture liveness — the reader
 * (`python/openbrain/src/openbrain/apps/capture/liveness.py`) and the endpoint
 * plumbing (`server/transport/health.ts:138`, `:194`) — and its own report
 * recorded that no process composes it, so `/health` never reported capture.
 * An optional input that no composition root supplies is dead code with a
 * docstring. This is the gatherer that makes it live.
 *
 * WHY ARRIVALS, AND NOT THE WATERMARK OR THE SPOOL. #648's residual-risk field
 * named the blocker precisely: `WatermarkStore` and `OutageLatch` are strictly
 * single-key with no enumeration method (`watermark.py:196-245`,
 * `outage.py:375-440`), so nothing can ask them "which sessions exist?". They
 * are also per-hook CLIENT-side files living on whatever machine ran the
 * session; a server process cannot read them at all, and inventing an
 * enumeration for them is its own decision rather than a detail to settle here.
 *
 * What the server CAN see is the thing those mechanisms exist to protect:
 * turns landing in `ob_raw_turns`. `docs/decisions/capture-never-drops-a-turn.md:182-200`
 * publishes exactly this as the correct health check, PER ROLE, and explains
 * why with the measurement that forced it — #447 hid for six days behind a
 * healthy lane total while the assistant side sat at zero.
 *
 * HONEST ABOUT WHAT IT CANNOT SEE. The two counts this vantage point cannot
 * observe are reported as "no evidence of fault", never as zero-meaning-broken:
 *
 *   - `watermark_bytes_advanced` is reported as delivered turns, not as 0. The
 *     reader treats 0 bytes while sessions ran as the WEDGED-WATERMARK fault
 *     (`liveness.py`), so a gatherer that passed a literal 0 because it cannot
 *     measure bytes would degrade every healthy deployment on earth. Turns
 *     arriving IS the watermark advancing — that is what a turn is evidence of
 *     — so the substitution preserves the property the field is about rather
 *     than the units, which is the round-10 lesson about picking a neutral
 *     value that keeps the property under test intact.
 *   - `spool_pending` is 0 and `outage_announcements` is 0. The reader's
 *     silent-spool fault requires `spool_pending > 0`, so this pair is
 *     structurally incapable of manufacturing that fault. A server-side spool
 *     reading would need the client-side enumeration that does not exist; the
 *     fault stays unobservable from here, and reporting it as absent is honest
 *     where reporting it as present would be a fabrication.
 *
 * This is announced rather than silent (AGENTS.md, "Nothing is adjusted
 * silently"): `observableFaults` names which of the reader's three faults this
 * vantage point can actually raise, and it travels into the health block.
 *
 * ABSENCE IS NOT STALENESS. A deployment that runs no capture lane composes no
 * observer and publishes no block (`docs/lane-contract.md` Tightenings rounds 8
 * and 13). A composed observer that has seen nothing at all returns `undefined`
 * rather than a verdict — a fresh process and a quiet window are not evidence
 * of a dead lane, and `MIN_SESSIONS_FOR_SILENCE` in the reader guards the same
 * boundary from the other side.
 *
 * NO WALL-CLOCK VERDICT. `silence_seconds` is computed for an operator to read
 * and is never compared against a threshold here or downstream
 * (`docs/lane-contract.md` Tightenings round 5 — wall-clock assertions are
 * flake generators, #632/#634).
 */
import type { Logger } from "pino";
import type { Pool } from "pg";
import type { TransportCaptureHealth } from "../transport/index.ts";

/**
 * Sessions that must be observed before total silence counts as a fault.
 *
 * Mirrors `MIN_SESSIONS_FOR_SILENCE` in
 * `python/openbrain/src/openbrain/apps/capture/liveness.py`, deliberately and
 * with the same value: below this, silence is ordinary, and an alarm that fires
 * on a quiet afternoon stops being read. The constant is duplicated rather than
 * shared because the two live in different languages; `captureLivenessQuorum`
 * is exported so a test can pin them together rather than let them drift
 * silently.
 */
export const MIN_SESSIONS_FOR_SILENCE = 2;

/** The roles a healthy capture lane is expected to deliver. */
const EXPECTED_ROLES = ["user", "assistant"] as const;

/**
 * Faults this vantage point can actually raise, named in the reading.
 *
 * The reader defines three (wedged watermark, unannounced spool, silent role);
 * a server reading arrivals can observe exactly one of them. Publishing the
 * list stops a future operator reading a green capture block as "all three
 * faults checked and clear" when one of them was never observable.
 */
const OBSERVABLE_FAULTS = ["silent_role"] as const;

export interface CaptureObservationWindow {
  /** How far back to count arrivals. Counts, not a verdict — see module docs. */
  readonly windowMinutes: number;
  /** Namespace whose capture lane this process reports on. */
  readonly namespace: string;
}

export interface CaptureObserverInput {
  readonly pool: Pool;
  readonly logger: Logger;
  readonly window: CaptureObservationWindow;
  /** Injected for tests; seconds, monotonic-comparable. */
  readonly now?: () => number;
}

/**
 * One gathered observation. Deliberately the shape the Python reader's
 * `CaptureObservation` takes, so the two stay legible side by side.
 */
export interface CaptureObservation {
  readonly sessionsObserved: number;
  readonly watermarkBytesAdvanced: number;
  readonly spoolPending: number;
  readonly outageAnnouncements: number;
  readonly turnsByRole: Readonly<Record<string, number>>;
  readonly silenceSeconds: number;
}

interface RoleCountRow {
  readonly role: string;
  readonly turns: string;
  readonly sessions: string;
  readonly seconds_since_last: string | null;
}

/**
 * Judge one observation. The TypeScript twin of `read_capture_liveness`.
 *
 * Kept as a pure function over counts for the reason the Python module's
 * docstring gives at length: every source this reasons about is touched by a
 * `Stop` hook inside a 5-second deadline, and a liveness reader that could
 * block one would be strictly worse than the blindness it removes. Nothing here
 * opens a file, takes a lock, or reads a clock it was not handed.
 */
export function readCaptureLiveness(
  observation: CaptureObservation | undefined,
): TransportCaptureHealth | undefined {
  if (observation === undefined) return undefined;

  const turnsDelivered = Object.values(observation.turnsByRole).reduce(
    (total, turns) => total + turns,
    0,
  );
  const active = observation.sessionsObserved >= MIN_SESSIONS_FOR_SILENCE;

  const watermarkWedged = active && observation.watermarkBytesAdvanced === 0;
  const spoolUnannounced =
    observation.spoolPending > 0 && observation.outageAnnouncements === 0;
  const silentRoles = active
    ? Object.entries(observation.turnsByRole)
        .filter(([, turns]) => turns === 0)
        .map(([role]) => role)
        .sort()
    : [];

  const faults: string[] = [];
  if (watermarkWedged) {
    faults.push(
      `watermark advanced 0 bytes across ${observation.sessionsObserved} session(s)`,
    );
  }
  if (spoolUnannounced) {
    faults.push(
      `spool holds ${observation.spoolPending} record(s) with no outage announced`,
    );
  }
  if (silentRoles.length > 0) {
    faults.push(`role(s) delivered nothing: ${silentRoles.join(", ")}`);
  }

  return {
    stale: faults.length > 0,
    watermark_wedged: watermarkWedged,
    spool_unannounced: spoolUnannounced,
    silent_roles: silentRoles,
    sessions_observed: observation.sessionsObserved,
    turns_delivered: turnsDelivered,
    spool_pending: observation.spoolPending,
    silence_seconds: Math.max(0, observation.silenceSeconds),
    reason: faults.length > 0 ? faults.join("; ") : "capture lane delivering",
  };
}

export interface CaptureLivenessObserver {
  /**
   * The latest reading, or `undefined` when nothing has been observed yet.
   *
   * Synchronous on purpose: `/health` reads it per request through a closure,
   * and a health endpoint that issues its own query on every probe turns a
   * monitor into load. The refresh runs on its own cadence, below.
   */
  reading(): TransportCaptureHealth | undefined;
  /** Gather once. Exposed so a caller (and a check) can drive it explicitly. */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Count arrivals per role over the window.
 *
 * One query, grouped by role, exactly as
 * `capture-never-drops-a-turn.md:193-197` publishes it — with the session count
 * added, because "zero turns" is only meaningful against a denominator of
 * sessions that actually ran.
 *
 * A role that delivered NOTHING has no rows and therefore no group, so the
 * expected roles are seeded at zero before the rows are folded in. Without that
 * seed the silent-role fault would be structurally unreachable: the dead
 * speaker is precisely the one with no rows to group.
 */
async function gather(
  input: CaptureObserverInput,
): Promise<CaptureObservation | undefined> {
  const rows = await input.pool.query<RoleCountRow>(
    `SELECT role,
            count(*)                                        AS turns,
            count(DISTINCT session_ref)                     AS sessions,
            extract(epoch FROM now() - max(created_at))     AS seconds_since_last
       FROM ob_raw_turns
      WHERE namespace = $1
        AND created_at > now() - ($2 || ' minutes')::interval
      GROUP BY role`,
    [input.window.namespace, String(input.window.windowMinutes)],
  );

  const turnsByRole: Record<string, number> = {};
  for (const role of EXPECTED_ROLES) turnsByRole[role] = 0;

  let sessionsObserved = 0;
  let turnsDelivered = 0;
  let silenceSeconds = 0;
  for (const row of rows.rows) {
    const turns = Number(row.turns);
    turnsByRole[row.role] = turns;
    turnsDelivered += turns;
    sessionsObserved = Math.max(sessionsObserved, Number(row.sessions));
    const since = row.seconds_since_last === null ? 0 : Number(row.seconds_since_last);
    silenceSeconds = Math.max(silenceSeconds, 0);
    if (silenceSeconds === 0 || since < silenceSeconds) silenceSeconds = since;
  }

  // Nothing at all in the window is NOT a dead lane: it is a fresh process, a
  // quiet night, or a namespace nobody is capturing. Publish nothing rather
  // than assert a verdict from no evidence.
  if (rows.rows.length === 0) return undefined;

  return {
    sessionsObserved,
    // See the module docstring: turns arriving IS the watermark advancing, and
    // a literal 0 here would raise a fault this vantage point cannot observe.
    watermarkBytesAdvanced: turnsDelivered,
    spoolPending: 0,
    outageAnnouncements: 0,
    turnsByRole,
    silenceSeconds,
  };
}

/**
 * Compose an observer that refreshes on its own cadence.
 *
 * The refresh is decoupled from `/health` deliberately. A probe that ran the
 * query inline would put a monitor's polling rate directly onto the database,
 * and a slow query would then make the health endpoint itself the outage —
 * the same shape `outage.py` records from the capture path, where a healthy
 * component holding a resource another waited on stalled a hook past its
 * deadline and dropped the turn.
 */
export function createCaptureLivenessObserver(
  input: CaptureObserverInput,
  options: { readonly refreshIntervalMs?: number; readonly autoStart?: boolean } = {},
): CaptureLivenessObserver {
  let latest: TransportCaptureHealth | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = async (): Promise<void> => {
    try {
      latest = readCaptureLiveness(await gather(input));
    } catch (error: unknown) {
      // A failed gather must not fabricate either verdict. Keeping the previous
      // reading and logging the category preserves "absence is not staleness"
      // through the failure path too: a database hiccup is not evidence the
      // capture lane died, and reporting it as such would train an operator to
      // ignore the signal.
      input.logger.warn(
        {
          error_category: error instanceof Error ? error.name : typeof error,
          observable_faults: OBSERVABLE_FAULTS,
        },
        "capture_liveness_gather_failed",
      );
    }
  };

  if (options.autoStart !== false) {
    timer = setInterval(() => {
      void refresh();
    }, options.refreshIntervalMs ?? 60_000);
    // Do not hold the process open for a health reading.
    timer.unref?.();
    void refresh();
  }

  return {
    reading: () => latest,
    refresh,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
