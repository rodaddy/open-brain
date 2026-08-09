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
 * WHY QUARANTINE IS DIFFERENT FROM SPOOL DEPTH (#680, cutover blocker B2). The
 * paragraph above is right about `spool_pending` and does NOT extend to
 * abandoned units, which is the distinction that let a real data loss stay
 * invisible. `spoolQuarantined` is an OPTIONAL REPORTED input, not something
 * this gatherer discovers: a client already computes the count
 * (`SpoolStatus.quarantined_count`) and can hand it over, so no enumeration
 * has to be invented. This gatherer does not report it — the arrivals query
 * genuinely cannot see it — so it leaves the field UNDEFINED and the judge
 * publishes no count, rather than the hardcoded 0 that used to stand in for an
 * unmeasured quantity. That hardcoded 0 is exactly what `/health` was showing
 * on 2026-07-30 while fifteen turns sat abandoned in a sidecar, permanently.
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
  /**
   * Units a capture lane ABANDONED after exhausting its replay attempts (#680).
   *
   * OPTIONAL, and its absence is not zero. This is a REPORTED input, not
   * something a server discovers: the module docstring's argument that a
   * server cannot enumerate client-side spool files is correct for
   * `spoolPending` and does NOT extend to this, because a quarantine count is
   * something a client already computes (`SpoolStatus.quarantined_count`) and
   * can hand over. A vantage point with no reporter leaves it undefined, and
   * the judge then publishes no count rather than a fabricated 0 — which is
   * the whole lesson of the field that sits above it.
   */
  readonly spoolQuarantined?: number;
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

  // ABANDONED RECORDS ARE A FAULT WHENEVER THEY EXIST (#680), with no
  // `active` guard. The other faults ask "is the lane working right now?", so
  // they are meaningless below quorum — a quiet night is not a dead lane.
  // This one is not a liveness question at all: it is a report that data is
  // already gone and stays gone until a human acts. A quarantine count is
  // equally true on a busy Tuesday and an idle Sunday, so gating it on
  // sessions observed would hide exactly the deployment that stopped
  // capturing BECAUSE its records were being abandoned.
  const quarantined = observation.spoolQuarantined;
  const quarantineFault = quarantined !== undefined && quarantined > 0;

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
  if (quarantineFault) {
    faults.push(
      `${String(quarantined)} unit(s) quarantined — replay gave up, records are lost until an operator replays the sidecar`,
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
    // Present only when something actually reported it. Spreading a
    // conditional rather than writing `?? 0` is the entire point: an absent
    // count and a zero count are different facts, and the fabricated zero is
    // the defect (#680).
    ...(quarantined === undefined ? {} : { quarantined_count: quarantined }),
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
  /**
   * The raw counts behind the latest reading, or `undefined` when nothing has
   * been observed yet.
   *
   * The application's health port takes an OBSERVATION and judges it with
   * `readCaptureLiveness` per request (`server/application/index.ts:204`), so
   * a composition root needs the counts, not the verdict. Retaining them is
   * what keeps ONE judge of record: deriving an observation back out of a
   * finished reading would have to invent a per-role split from a total, and
   * the per-role split is the entire point (#447).
   */
  observation(): CaptureObservation | undefined;
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
  let latestObservation: CaptureObservation | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = async (): Promise<void> => {
    try {
      const observed = await gather(input);
      latestObservation = observed;
      latest = readCaptureLiveness(observed);
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
    observation: () => latestObservation,
    refresh,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Env var naming the tenant whose capture lane this process reports on. */
export const CAPTURE_HEALTH_NAMESPACE_ENV = "OPENBRAIN_CAPTURE_HEALTH_NAMESPACE";
/** Env var overriding the observation window, in minutes. */
export const CAPTURE_HEALTH_WINDOW_ENV = "OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES";
/** Env var overriding the refresh cadence, in milliseconds. */
export const CAPTURE_HEALTH_REFRESH_ENV = "OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS";

/** Ruled default observation window: 6 hours (ledger item 28). */
export const DEFAULT_CAPTURE_WINDOW_MINUTES = 360;
/** Ruled default refresh cadence: 60 seconds (ledger item 28). */
export const DEFAULT_CAPTURE_REFRESH_MS = 60_000;

export interface CaptureHealthRuntime {
  /**
   * The port `createShadowApplication` takes, or `undefined` when this
   * deployment composes no capture lane. Absence, not a neutral value: the
   * application omits the block entirely and the health verdict is untouched.
   */
  readonly captureObserver?: () => CaptureObservation | undefined;
  /** Stop the refresh timer. Safe to call when no observer was built. */
  stop(): void;
}

export interface CaptureHealthRuntimeInput {
  readonly env: Record<string, string | undefined>;
  readonly pool: Pool;
  readonly logger: Logger;
  /** Injected for checks; skips the timer and the boot refresh. */
  readonly autoStart?: boolean;
}

/**
 * Build the capture-health observer this PROCESS should run, from config.
 *
 * WHY THE NAMESPACE IS REQUIRED AND HAS NO FALLBACK (operator ruling
 * 2026-08-08, ledger item 28 in `docs/issue-graph.md`). The namespace is the
 * Open Brain data-tenant column on `ob_*` rows — the auth-derived security
 * boundary — so guessing one is not a convenience, it is this process
 * reporting on someone else's data and calling the answer its own health. The
 * ruling generalizes past this observer: identity-selecting config is explicit
 * per deployment, loud on absence, never silently substituted, and a literal
 * "default" tenant is a symptom to fix rather than a value to fall back on.
 *
 * ABSENCE IS LOUD IN THE LOG AND QUIET IN /health, WHICH ARE TWO DIFFERENT
 * AUDIENCES. Unset namespace means no observer, so `/health` publishes no
 * capture block and stays green — a deployment that runs no capture lane must
 * not report itself broken for a job it was never given
 * (`docs/lane-contract.md` Tightenings rounds 8 and 13). But a deployment that
 * MEANT to run one and forgot the variable would then be indistinguishable
 * from one that opted out, so the config notice is emitted at WARN, naming the
 * variable. The health verdict is for the monitor; the notice is for the
 * operator who has to fix the deploy.
 *
 * NOTHING IS ADJUSTED SILENTLY (AGENTS.md Coding Standards). When a ruled
 * default applies it is announced with the values it applied, and an
 * unparseable override is announced together with the default that replaced
 * it — never accepted as a number and never accepted as silence.
 */
export function createCaptureHealthRuntime(
  input: CaptureHealthRuntimeInput,
): CaptureHealthRuntime {
  const namespace = (input.env[CAPTURE_HEALTH_NAMESPACE_ENV] ?? "").trim();

  if (namespace === "") {
    input.logger.warn(
      {
        config_key: CAPTURE_HEALTH_NAMESPACE_ENV,
        capture_health_enabled: false,
        health_effect: "no capture block published; status unaffected",
      },
      "capture_health_namespace_missing",
    );
    return { stop: () => {} };
  }

  const windowMinutes = readPositiveInteger(
    input,
    CAPTURE_HEALTH_WINDOW_ENV,
    DEFAULT_CAPTURE_WINDOW_MINUTES,
  );
  const refreshIntervalMs = readPositiveInteger(
    input,
    CAPTURE_HEALTH_REFRESH_ENV,
    DEFAULT_CAPTURE_REFRESH_MS,
  );

  input.logger.info(
    {
      config_key: CAPTURE_HEALTH_NAMESPACE_ENV,
      capture_health_enabled: true,
      window_minutes: windowMinutes,
      window_source:
        input.env[CAPTURE_HEALTH_WINDOW_ENV] === undefined ? "default" : "env",
      refresh_interval_ms: refreshIntervalMs,
      refresh_source:
        input.env[CAPTURE_HEALTH_REFRESH_ENV] === undefined ? "default" : "env",
      observable_faults: OBSERVABLE_FAULTS,
    },
    "capture_health_defaults",
  );

  const observer = createCaptureLivenessObserver(
    {
      pool: input.pool,
      logger: input.logger,
      window: { windowMinutes, namespace },
    },
    {
      refreshIntervalMs,
      ...(input.autoStart === false ? { autoStart: false } : {}),
    },
  );

  // The port is the observer's RAW COUNTS, read per request. The application
  // judges them with `readCaptureLiveness` (`server/application/index.ts:204`),
  // which is the same judge this module exports — so there is exactly one
  // definition of "stale" in the process, and the refresh cadence stays the
  // only thing that decides how often the database is asked.
  return {
    captureObserver: () => observer.observation(),
    stop: () => observer.stop(),
  };
}

/**
 * Read a positive integer override, announcing whichever value wins.
 *
 * An unparseable or non-positive override is a CONFIG DEFECT, not a reason to
 * pretend the variable was unset: it is announced at WARN with both the
 * rejected text and the default that replaced it, so the transcript lets an
 * operator map what was asked for to what exists.
 */
function readPositiveInteger(
  input: CaptureHealthRuntimeInput,
  key: string,
  fallback: number,
): number {
  const raw = input.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    input.logger.warn(
      { config_key: key, rejected: raw.trim(), applied: fallback },
      "capture_health_override_invalid",
    );
    return fallback;
  }
  return parsed;
}
