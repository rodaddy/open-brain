/**
 * Gather the counts `/health` needs to judge the raw-capture lane, from the
 * only vantage point a SERVER actually has: arrivals in `ob_raw_turns`.
 *
 * Why arrivals rather than the watermark or the spool, and how the counts this
 * vantage point cannot observe are reported without fabricating a fault:
 * See docs/decisions/liveness-observer-arrivals-are-the-vantage-point.md
 *
 * Why a quiet window is not a verdict, and why `silence_seconds` is computed
 * for an operator to read but never compared against a threshold:
 * See docs/decisions/liveness-observer-absence-is-not-staleness.md
 *
 * `observableFaults` names which of the reader's three faults this vantage
 * point can actually raise, and it travels into the health block.
 */
import type { Logger } from "pino";
import type { Pool } from "pg";
import { EXPECTED_LIVE_ROLES } from "../domain/raw-turn-roles.ts";

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

/**
 * The roles a healthy capture lane is expected to deliver — DERIVED from the
 * set the server accepts, never retyped beside it (#681).
 *
 * This was a literal `["user", "assistant"]`, and it was correct for the enum
 * it was written next to until that enum grew a third member. The failure is
 * silent by construction: a role with no arrivals produces no `GROUP BY` group,
 * so a role that is neither seeded here nor present in the rows is never a key
 * in `turnsByRole` and `readCaptureLiveness` cannot name it. `tool` sat frozen
 * at 14,006 rows from 2026-08-01 while this module reported
 * `stale: false, silent_roles: []` — eight days of green over a dead speaker,
 * which is the #447 failure this module's own docstring cites as its reason to
 * exist, one role wider.
 *
 * Deriving rather than extending is deliberate: adding `"tool"` to the literal
 * would fix the instance and keep the mechanism, leaving role four to escape
 * liveness exactly as role three did. `RAW_TURN_ROLES` is the ingest
 * boundary's own set, so a role the server learns to accept becomes a role this
 * observer expects, with no second edit to forget.
 */
// Seeded from the LIVE-expected set, not the accept set (#685). The two are
// different questions and the accept set answers the wrong one: it includes
// `tool`, which no live producer emits by design, so seeding from it raised a
// permanent silent-role fault and rolled back every deploy. The subset relation
// between the two sets is pinned by raw-turn-roles.test.ts, so a role the
// boundary learns to accept still cannot escape liveness silently -- the #681
// lesson this module exists for is unchanged.
const EXPECTED_ROLES = EXPECTED_LIVE_ROLES;

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
  /**
   * The configured namespace, set ONLY when it has never had a single row
   * (issue 682). A typo in `OPENBRAIN_CAPTURE_HEALTH_NAMESPACE` otherwise reads
   * exactly like a quiet night: an empty window publishes nothing and
   * `/health` stays green forever. A namespace with rows outside the window
   * is a quiet lane and leaves this undefined.
   */
  readonly unknownNamespace?: string;
}

interface RoleCountRow {
  readonly role: string;
  readonly turns: string;
  readonly sessions: string;
  readonly seconds_since_last: string | null;
}

/**
 * The four per-signal classifications, decided once and read by both the fault
 * sentences and the published block.
 *
 * Split out so each signal is named where it is decided rather than inline in
 * one judge: the predicates, their `active` gating, and the sentences they
 * produce are the part a future reader has to check against the Python twin,
 * and they are easier to check when each carries its own name.
 */
interface CaptureFaultSignals {
  readonly watermarkWedged: boolean;
  readonly spoolUnannounced: boolean;
  readonly silentRoles: readonly string[];
  readonly quarantined: number | undefined;
  readonly unknownNamespace: string | undefined;
}

/**
 * Roles that delivered nothing while the lane was above quorum.
 *
 * Below quorum this is empty rather than "every role": a quiet night is not a
 * dead speaker, and `MIN_SESSIONS_FOR_SILENCE` is the boundary that says so.
 */
function classifySilentRoles(
  observation: CaptureObservation,
  active: boolean,
): string[] {
  if (!active) return [];
  return Object.entries(observation.turnsByRole)
    .filter(([, turns]) => turns === 0)
    .map(([role]) => role)
    .sort();
}

/**
 * Decide every signal from the counts, with the quorum gating each one carries.
 *
 * ABANDONED RECORDS ARE A FAULT WHENEVER THEY EXIST (#680), with no `active`
 * guard. The other faults ask "is the lane working right now?", so they are
 * meaningless below quorum — a quiet night is not a dead lane. This one is not
 * a liveness question at all: it is a report that data is already gone and
 * stays gone until a human acts. A quarantine count is equally true on a busy
 * Tuesday and an idle Sunday, so gating it on sessions observed would hide
 * exactly the deployment that stopped capturing BECAUSE its records were being
 * abandoned.
 */
function classifyCaptureFaults(observation: CaptureObservation): CaptureFaultSignals {
  const active = observation.sessionsObserved >= MIN_SESSIONS_FOR_SILENCE;
  return {
    watermarkWedged: active && observation.watermarkBytesAdvanced === 0,
    spoolUnannounced:
      observation.spoolPending > 0 && observation.outageAnnouncements === 0,
    silentRoles: classifySilentRoles(observation, active),
    quarantined: observation.spoolQuarantined,
    unknownNamespace: observation.unknownNamespace,
  };
}

/**
 * Render the operator-facing sentence for each raised signal, in the order the
 * reading has always published them. Order is part of the contract: `reason` is
 * a joined string a human reads, so reordering it is a behavior change.
 */
function describeCaptureFaults(
  observation: CaptureObservation,
  signals: CaptureFaultSignals,
): string[] {
  const faults: string[] = [];
  if (signals.unknownNamespace !== undefined) {
    faults.push(
      `${CAPTURE_HEALTH_NAMESPACE_ENV}="${signals.unknownNamespace}" names a namespace with no capture rows ever — check the value for a typo`,
    );
  }
  if (signals.watermarkWedged) {
    faults.push(
      `watermark advanced 0 bytes across ${observation.sessionsObserved} session(s)`,
    );
  }
  if (signals.spoolUnannounced) {
    faults.push(
      `spool holds ${observation.spoolPending} record(s) with no outage announced`,
    );
  }
  const quarantined = signals.quarantined;
  if (quarantined !== undefined && quarantined > 0) {
    faults.push(
      `${String(quarantined)} unit(s) quarantined — replay gave up, records are lost until an operator replays the sidecar`,
    );
  }
  if (signals.silentRoles.length > 0) {
    faults.push(`role(s) delivered nothing: ${signals.silentRoles.join(", ")}`);
  }
  return faults;
}

/**
 * The raw-capture lane's liveness, as `/health` reports it.
 *
 * WHY THIS IS A HEALTH INPUT AT ALL (#647, ledger item 25). Raw capture is
 * AUTOMATIC — a `Stop` hook reads since the watermark and delivers — and
 * automatic is what makes it dangerous: nothing was ever asked to notice it
 * stopping. `ob_raw_turns` records ARRIVALS; nothing anywhere read ABSENCE, so
 * a silently-dead capture lane was server-side indistinguishable from an idle
 * one. This is the #625 producer argument applied to the second background
 * lane, and it replaces an enforcement tier rather than adding a test: ledger
 * item 25 retired the capture merge-gate on the reasoning that gating a
 * human's PR is the wrong instrument for a background pipeline.
 *
 * Every field is derived from EVENT COUNTS by
 * `openbrain.apps.capture.liveness`. `silence_seconds` is reported, never
 * compared — a wall-clock verdict cannot tell a wedged pipeline from a quiet
 * afternoon (`docs/lane-contract.md`, Tightenings round 5).
 */
export interface TransportCaptureHealth {
  /** True once any capture fault below fired. */
  readonly stale: boolean;
  /** Sessions ran and the watermark advanced zero bytes. */
  readonly watermark_wedged: boolean;
  /** The spool holds records and the outage latch announced nothing. */
  readonly spool_unannounced: boolean;
  /**
   * Speakers that delivered nothing while the lane was active.
   *
   * PER ROLE, not per lane, and this field is the reason the block exists in
   * this shape: `docs/decisions/capture-never-drops-a-turn.md:188-200` records
   * that the operator's numbers stayed healthy for six days while the
   * assistant side sat at zero (#447). A lane total reads as busy traffic;
   * only the per-role view sees a dead speaker.
   */
  readonly silent_roles: readonly string[];
  readonly sessions_observed: number;
  readonly turns_delivered: number;
  readonly spool_pending: number;
  /**
   * Units the capture lane ABANDONED after exhausting its replay attempts.
   *
   * ABSENT, never 0, when no vantage point reported the count (#680). The two
   * states are genuinely different — "nothing was abandoned" and "nobody
   * looked" — and collapsing them into a confident zero is the exact defect
   * this field exists to end: on 2026-07-30 a hardcoded 0 stood in for an
   * unmeasured quantity while fifteen turns were gone for good, and `/health`
   * read `spool_pending:0, reason:"capture lane delivering"` over the top of
   * it.
   *
   * A monitor alerts on this crossing 0 -> 1, so a reporting vantage point
   * publishes a real 0 rather than omitting the field.
   */
  readonly quarantined_count?: number;
  /** Reported for an operator; no verdict is derived from it. */
  readonly silence_seconds: number;
  /** Content-free sentence naming which fault fired. */
  readonly reason: string;
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

  const signals = classifyCaptureFaults(observation);
  const { watermarkWedged, spoolUnannounced, silentRoles, quarantined } = signals;
  const faults = describeCaptureFaults(observation, signals);

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

  // Nothing at all in the window is NOT a dead lane: it is a fresh process or
  // a quiet night. Publish nothing rather than assert a verdict from no
  // evidence -- unless the namespace has NEVER had a row, which is a config
  // typo, not a quiet night (issue 682).
  if (rows.rows.length === 0) return unknownNamespaceObservation(input);

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
 * An empty window's verdict: `undefined` for a known namespace, and a
 * degraded observation naming the value for one that never had a row.
 *
 * Asked only after the window came back empty, so a delivering lane pays
 * nothing for it. "Known" means at least one row ever, with no time window.
 */
async function unknownNamespaceObservation(
  input: CaptureObserverInput,
): Promise<CaptureObservation | undefined> {
  const known = await input.pool.query<{ exists: boolean }>(
    `SELECT exists(SELECT 1 FROM ob_raw_turns WHERE namespace = $1) AS exists`,
    [input.window.namespace],
  );
  if (known.rows[0]?.exists === true) return undefined;
  const turnsByRole: Record<string, number> = {};
  for (const role of EXPECTED_ROLES) turnsByRole[role] = 0;
  return {
    sessionsObserved: 0,
    watermarkBytesAdvanced: 0,
    spoolPending: 0,
    outageAnnouncements: 0,
    turnsByRole,
    silenceSeconds: 0,
    unknownNamespace: input.window.namespace,
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
  options: {
    readonly refreshIntervalMs?: number;
    readonly autoStart?: boolean;
  } = {},
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
 * The namespace is required and has no fallback: unset means no observer, a
 * WARN config notice naming the variable, and a `/health` that stays green.
 * See docs/decisions/liveness-observer-namespace-has-no-fallback.md
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
