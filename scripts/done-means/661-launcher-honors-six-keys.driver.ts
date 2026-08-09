/**
 * DONE-MEANS driver for #661 — the launcher HONORS the configured keys that
 * #660 taught it to announce as dropped, and stops announcing the one that was
 * never a configuration at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE ISSUE FROM #659
 * ---------------------------------------------------------------------------
 * #659 made the drop VISIBLE: `describeDroppedChildEnvironment` names every
 * configured-looking key the allowlist discards, and the start path announces
 * it before spawning. The moment drops became visible, the deployed clone's
 * boot line named six more keys that had been silently dropped for their whole
 * life. Observed RUNNING 2026-08-08 22:45Z.
 *
 * ---------------------------------------------------------------------------
 * THE AMENDED RULING (29.2a) AND WHY IT IS FIVE, NOT SIX
 * ---------------------------------------------------------------------------
 * Ledger item 29.2 read "all six are honored". Writing this check RED-first
 * proved one of the six could not be: the launcher THREW on it, at a guard,
 * before reaching the allowlist at all.
 *
 *   FAIL (b) Local clone mode prohibits EMBEDDING_WATCHDOG_RESTART_SCRIPT
 *
 * `src/local-clone-mode.ts:15` lists that key in `PROHIBITED_PATH_KEYS` and
 * lines 190-194 refuse any non-empty value, pinned by a passing test at
 * `src/local-clone-mode.test.ts:138-145`. In the deployed env file it is set
 * EMPTY (`local-clone.env:17`) — the documented clone-mode suppression form,
 * shown as exactly `EMBEDDING_WATCHDOG_RESTART_SCRIPT=` in
 * `docs/local-clone-dogfood.md:147`, the same shape as `QMD_PATH=`. It appeared
 * in the boot line only because the reporter skipped on `undefined` and not on
 * the empty string, so an explicitly-DISABLED key read as a dropped
 * CONFIGURATION.
 *
 * Operator ruling 2026-08-08 (29.2a) on that finding: honor the FIVE keys that
 * carry real values, leave the watchdog key out because the clone-mode
 * prohibition guard wins, and teach the reporter to tell unset / set-empty /
 * set-valued apart.
 *
 *   HONORED (five):  LOG_LEVEL, LOG_MAX_BYTES, LOG_MAX_FILES,
 *                    OPENBRAIN_MCP_AUDIT_ENABLED, SERVICE_NAME
 *   NOT honored:     EMBEDDING_WATCHDOG_RESTART_SCRIPT (prohibited in clone
 *                    mode; empty in the env file means deliberately off)
 *
 * Announcing a deliberate configuration and then ignoring it is
 * accept-and-ignore with a receipt — the #464 class one step further along, and
 * the same deploy coupling as #530 (tracing) and #659 (capture-health). The
 * announcement is the correct mechanism; it is not the resolution. But
 * announcing a deliberate SUPPRESSION is the mirror defect: a false positive
 * that teaches an operator the line is noise.
 *
 * ---------------------------------------------------------------------------
 * CLAUSES
 * ---------------------------------------------------------------------------
 *   (a) Each of the five honored keys, set in the input env, appears in
 *       `buildChildEnvironment` output with its configured value. RED on the
 *       pre-fix tree: all five are absent.
 *   (b) With the five honored and the watchdog key empty-suppressed, the
 *       launcher's boot announcement for THIS env file goes SILENT. Both halves
 *       in ONE clause (round 18): no announce line at all AND the five keys
 *       present in the spawned child's env. Split apart, "no announce line"
 *       passes on a launcher that announces nothing and delivers nothing —
 *       which is the pre-#659 world. Driven through the REAL
 *       `runLocalCloneLauncher` start path via its injected boundaries, because
 *       the launcher spawn chain is exactly the seam #659 lived in.
 *   (c) CONTROL, mutation-proofed — the allowlist stays an allowlist AND the
 *       announce mechanism stays alive. A junk unlisted key carrying a HONORED
 *       key's own prefix must still NOT reach the child, and MUST still be
 *       announced. Both halves in one clause: a fix that waves the LOG_ or
 *       SERVICE_ family through fails the first half; a fix that honors the
 *       five by deleting the drop report fails the second.
 *   (d) CONTROL — the families that already worked still work: DB_*,
 *       AUTH_TOKEN_*, AUTH_TOKEN_USER_*, OPENBRAIN_TRACING_*, and the #659
 *       OPENBRAIN_CAPTURE_HEALTH_* keys. Passes PRE-fix by design (round 13: a
 *       check that fails everywhere proves only that it fails).
 *   (e) The three-state rule, with its own mutation proof. An explicitly-EMPTY
 *       key is NOT announced (it is a suppression, not a dropped config), while
 *       a set-VALUED unlisted key with the IDENTICAL NAME IS. Both halves in one
 *       clause over the same key, differing only in value: that is the mutation.
 *       Neither half alone constrains anything — "empty not announced" passes on
 *       a reporter that announces nothing, and "valued announced" passes on
 *       today's over-reporting one. Asserted for the real watchdog key and for a
 *       synthetic one, so the rule is the VALUE STATE and not a name allowlist.
 *
 * No database, no network, no real child process: the subjects are a pure
 * function over a record plus the launcher's already-injectable boundaries.
 * Content-free output — clause names, states, key names, never values.
 */
import {
  buildChildEnvironment,
  runLocalCloneLauncher,
  type LocalCloneLauncherDependencies,
} from "../local-clone.ts";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

/**
 * A real directory for the clone-root fixture.
 *
 * `src/local-clone-mode.ts` requires OPENBRAIN_LOCAL_CLONE_ROOT to EXIST, and
 * clause (b) drives that validation for real. Repo-relative and gitignored
 * rather than an absolute machine path — a hardcoded `/Volumes/...` default
 * died with EACCES on the Linux CI runner once already (docs/lane-contract.md,
 * #612 harvest).
 */
const CLONE_ROOT = fileURLToPath(
  new URL("../../_scratch/done-means-661-clone-root", import.meta.url),
);

/**
 * The FIVE keys honored under amended ruling 29.2a, with the values the
 * deployed env file actually carries (`local-clone.env:36,40-43`). Real values
 * rather than invented ones: round 12 — query the real distribution before
 * inventing a fixture shape.
 */
const HONORED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["LOG_LEVEL", "debug"],
  ["LOG_MAX_BYTES", "67108864"],
  ["LOG_MAX_FILES", "12"],
  ["OPENBRAIN_MCP_AUDIT_ENABLED", "1"],
  ["SERVICE_NAME", "open-brain"],
] as const;

/**
 * The sixth key from the original ruling, held OUT by amendment 29.2a.
 *
 * `src/local-clone-mode.ts:15` prohibits it in clone mode and the launcher
 * throws on any non-empty value. The deployed env file sets it EMPTY
 * (`local-clone.env:17`), which `docs/local-clone-dogfood.md:147` documents as
 * the suppression form. It must reach neither the child nor the drop report.
 */
const SUPPRESSED_KEY = "EMBEDDING_WATCHDOG_RESTART_SCRIPT";

const results: Array<{ clause: string; ok: boolean; detail: string }> = [];

function clause(name: string, ok: boolean, detail: string): void {
  results.push({ clause: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  (${name}) ${detail}`);
}

/**
 * The env the deployed clone actually runs with, INCLUDING the six keys whose
 * silent drop #660's announcement exposed.
 *
 * The key set is the deployed one, not an invented shape (round 12: query the
 * real distribution before inventing a fixture). Ambient launchd vars are
 * present because `scripts/local-clone-autostart.sh` sources the env file with
 * `set -a`, so the launcher's environment is the file UNIONED with launchd's.
 */
function deployedEnv(): Record<string, string | undefined> {
  return {
    // --- allowlisted before this change, must keep passing (clause d) ---
    ALLOWED_ORIGINS: "http://127.0.0.1:7100",
    AUTH_TOKEN_ADMIN: "placeholder-admin",
    AUTH_TOKEN_AGENT: "placeholder-agent",
    AUTH_TOKEN_DISCORD: "placeholder-discord",
    AUTH_TOKEN_OB_ADMIN: "placeholder-ob-admin",
    AUTH_TOKEN_PROMOTER: "placeholder-promoter",
    AUTH_TOKEN_READONLY: "placeholder-readonly",
    AUTH_TOKEN_USER_RICO: "rico:placeholder-user-token",
    DB_HOST: "127.0.0.1",
    DB_NAME: "open_brain_local_clone",
    DB_PASSWORD: "placeholder-db-password",
    DB_POOL_MAX: "10",
    DB_PORT: "55432",
    DB_USER: "open_brain_local_clone",
    EMBEDDING_API_KEY: "placeholder-embedding-key",
    EMBEDDING_BASE_URL: "http://127.0.0.1:8791/v1",
    EMBEDDING_DIMENSIONS: "768",
    EMBEDDING_MODEL: "embeddinggemma-300m-8bit",
    // Both runtime paths must sit beneath OPENBRAIN_LOCAL_CLONE_ROOT —
    // `src/local-clone-mode.ts` enforces it, and clause (b) drives the real
    // launcher through that validation.
    LOG_FILE: `${CLONE_ROOT}/logs/open-brain.log`,
    OPEN_BRAIN_BIND_HOST: "127.0.0.1",
    OPEN_BRAIN_MAINTENANCE_ENABLED: "1",
    OPEN_BRAIN_RUN_MIGRATIONS: "0",
    OPENBRAIN_CAPTURE_HEALTH_NAMESPACE: "rico",
    OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS: "60000",
    OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES: "360",
    OPENBRAIN_LOCAL_CLONE: "1",
    OPENBRAIN_LOCAL_CLONE_ROOT: CLONE_ROOT,
    OPENBRAIN_RECOVERY_WAL_PATH: `${CLONE_ROOT}/recovery.wal`,
    OPENBRAIN_TRACING_ENABLED: "1",
    OPENBRAIN_TRACING_ENDPOINT: "http://tracing.invalid:3000",
    OPENBRAIN_TRACING_PUBLIC_KEY: "placeholder-public",
    OPENBRAIN_TRACING_SECRET_KEY: "placeholder-secret",
    OPENBRAIN_TRANSPORT: "http",
    PORT: "3100",
    // Clone mode requires QMD_PATH to be explicitly EMPTY, not merely unset.
    QMD_PATH: "",

    // --- the #661 subject: configured deliberately, announced, still dropped ---
    ...Object.fromEntries(HONORED_KEYS),
    // Explicitly EMPTY, exactly as the deployed env file sets it. Prohibited in
    // clone mode with a value; a deliberate suppression when empty. Must reach
    // neither the child nor the drop report.
    [SUPPRESSED_KEY]: "",

    // --- ambient, must NEVER reach the child and must NOT be announced ---
    PATH: "/usr/bin:/bin",
    HOME: "/placeholder/home",
    SSH_AUTH_SOCK: "/placeholder/ssh-agent.sock",
  };
}

/**
 * A key that is not in the allowlist and never will be — the negative control.
 *
 * It carries `LOG_`, one of the prefixes this change touches, on purpose: the
 * lazy way to honor LOG_LEVEL/LOG_MAX_BYTES/LOG_MAX_FILES is a whole-family
 * passthrough, and that "fix" must fail clause (c). `SERVICE_` gets the same
 * treatment via a second junk key.
 */
const JUNK_KEYS = [
  "LOG_DEFINITELY_NOT_A_REAL_SERVER_KEY",
  "SERVICE_DEFINITELY_NOT_A_REAL_SERVER_KEY",
] as const;

/** One dropped key, as the launcher reports it: named, never valued. */
interface DroppedChildEnvEntry {
  readonly key: string;
}
type DropReporter = (
  env: Record<string, string | undefined>,
) => readonly DroppedChildEnvEntry[];

/**
 * Load the drop reporter DYNAMICALLY.
 *
 * Round 18: a done-means check for an export that may not exist at the tree
 * being measured must import it at RUNTIME. A static import against a tree
 * lacking the export dies at module resolution before any clause prints — a
 * false RED indistinguishable in shape from a real one. `describeDropped-
 * ChildEnvironment` exists on `main` today (it shipped in #660), but resolving
 * it dynamically keeps this driver's RED regenerable against any tree, which is
 * the property that makes the check reusable rather than a one-shot.
 */
async function loadDropReporter(): Promise<DropReporter | undefined> {
  const module = (await import("../local-clone.ts")) as Record<string, unknown>;
  const reporter = module.describeDroppedChildEnvironment;
  return typeof reporter === "function"
    ? (reporter as DropReporter)
    : undefined;
}

const MISSING_REPORTER =
  "scripts/local-clone.ts exports no describeDroppedChildEnvironment — " +
  "the #659/#660 announce mechanism is gone, so the drop is silent again";

/** A launcher child stub that exits 0 as soon as it is spawned. */
function stubChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { exitCode: null, signalCode: null, kill: () => true });
  return child;
}

function launcherDependencies(
  announced: string[],
  capture: { env?: Record<string, string> },
): LocalCloneLauncherDependencies {
  const child = stubChild();
  return {
    database: {
      prove: async () => ({
        database: "open_brain_local_clone",
        user: "open_brain_local_clone",
        serverAddress: "127.0.0.1",
        serverPort: 55432,
        postgresMajor: 18,
        transactionReadOnly: true,
        pgvectorAvailable: true,
        pgvectorInstalled: true,
      }),
    },
    embedding: {
      prove: async () => ({
        model: "embeddinggemma-300m-8bit",
        dimensions: 768,
      }),
    },
    child: {
      spawn: (childEnv) => {
        capture.env = childEnv;
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
    },
    writeReceipt: () => {},
    onSignal: () => () => {},
    announce: (line: string) => announced.push(line),
  };
}

async function main(): Promise<void> {
  mkdirSync(CLONE_ROOT, { recursive: true });
  const describeDropped = await loadDropReporter();

  // -------------------------------------------------------------------------
  // Clause (a) — each of the five honored keys reaches the child with its value,
  // and the empty-suppressed watchdog key does NOT.
  //
  // Asserted per key, not as a tally: a partial fix that adds four of five is a
  // deploy that still silently ignores an operator decision, and a count would
  // report that as "mostly done". The suppressed key is asserted here too so
  // that "honor the five" cannot quietly become "honor everything announced".
  // -------------------------------------------------------------------------
  {
    const child = buildChildEnvironment(deployedEnv());
    const missing = HONORED_KEYS.filter(([key]) => child[key] === undefined).map(
      ([key]) => key,
    );
    const wrongValue = HONORED_KEYS.filter(
      ([key, value]) => child[key] !== undefined && child[key] !== value,
    ).map(([key]) => key);
    const suppressedLeaked = child[SUPPRESSED_KEY] !== undefined;
    const ok =
      missing.length === 0 && wrongValue.length === 0 && !suppressedLeaked;
    clause(
      "a",
      ok,
      ok
        ? `all ${HONORED_KEYS.length} operator-ruled keys reach the server child with their configured values ` +
            `(${HONORED_KEYS.map(([key]) => key).join(", ")}), and the clone-mode-prohibited ` +
            `${SUPPRESSED_KEY} correctly does not`
        : [
            missing.length > 0
              ? `ruled keys DROPPED by the launcher: ${missing.join(", ")} — the operator configured them deliberately and the child never sees them`
              : "",
            wrongValue.length > 0
              ? `delivered with a MUTATED value: ${wrongValue.join(", ")}`
              : "",
            suppressedLeaked
              ? `${SUPPRESSED_KEY} reached the child — clone mode prohibits it (src/local-clone-mode.ts:15)`
              : "",
          ]
            .filter(Boolean)
            .join("; "),
    );
  }

  // -------------------------------------------------------------------------
  // Clause (b) — with all six honored, the boot announcement goes SILENT.
  //
  // BOTH halves in one clause (round 18). "No announce line" alone passes on a
  // launcher that announces nothing — the pre-#659 world, which is the bug this
  // whole thread exists to kill. "Keys present" alone passes on a launcher that
  // delivers them and still shouts about dropping them. The claim is a QUIET
  // BOOT FOR A FULLY-HONORED ENV FILE, and only the conjunction states it.
  //
  // Driven through the real `runLocalCloneLauncher` start path: #659 survived a
  // passing unit check because the launcher spawn chain was outside its
  // vantage. The seam is the subject.
  // -------------------------------------------------------------------------
  {
    const announced: string[] = [];
    const capture: { env?: Record<string, string> } = {};
    try {
      const code = await runLocalCloneLauncher(
        "start",
        deployedEnv(),
        launcherDependencies(announced, capture),
      );
      const missing = HONORED_KEYS.filter(
        ([key, value]) => capture.env?.[key] !== value,
      ).map(([key]) => key);
      const silent = announced.length === 0;
      clause(
        "b",
        code === 0 && silent && missing.length === 0,
        `boot on the deployed env file: exit=${code}, announce lines=${
          announced.length
        }, ruled keys missing from the spawned child=${
          missing.length === 0 ? "none" : missing.join(", ")
        }` +
          (silent && missing.length === 0
            ? " — a fully-honored env file boots quiet"
            : silent
              ? " — quiet boot, but the child did not get the keys: silence without delivery is the pre-#659 world"
              : ` — the launcher still reports dropping configured keys: ${announced.join(" | ")}`),
      );
    } catch (error: unknown) {
      clause(
        "b",
        false,
        `the launcher start path threw before completing: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Clause (c) — CONTROL, mutation-proofed on both halves.
  //
  // Round 9/18: a clause whose PASS comes from a negative match passes both
  // when the thing is absent and when the check is broken. So the negative
  // ("junk key does NOT reach the child") is paired in ONE clause with the
  // positive that keeps it honest ("junk key IS still announced").
  //
  // A fix that honors LOG_LEVEL by passing the whole `LOG_` family fails the
  // first half. A fix that silences the boot line by deleting the drop report
  // — which would also make clause (b) pass for the wrong reason — fails the
  // second. The junk keys carry `LOG_` and `SERVICE_` precisely so the lazy
  // family-passthrough route is the one that trips.
  // -------------------------------------------------------------------------
  {
    const env = {
      ...deployedEnv(),
      ...Object.fromEntries(
        JUNK_KEYS.map((key) => [key, "configured-but-unlisted"]),
      ),
    };
    const child = buildChildEnvironment(env);
    const leaked = [...JUNK_KEYS, "PATH", "HOME", "SSH_AUTH_SOCK"].filter(
      (key) => child[key] !== undefined,
    );

    if (describeDropped === undefined) {
      clause("c", false, MISSING_REPORTER);
    } else {
      const names = describeDropped(env).map((entry) => entry.key);
      const unannounced = JUNK_KEYS.filter((key) => !names.includes(key));
      const noisy = ["PATH", "HOME", "SSH_AUTH_SOCK"].filter((key) =>
        names.includes(key),
      );
      const serialized = JSON.stringify(describeDropped(env));
      const leaksValue = serialized.includes("configured-but-unlisted");
      const ok =
        leaked.length === 0 &&
        unannounced.length === 0 &&
        noisy.length === 0 &&
        !leaksValue;
      clause(
        "c",
        ok,
        ok
          ? `control: the allowlist still holds (${JUNK_KEYS.join(", ")} and the ambient host vars excluded) ` +
              "AND the announce mechanism still names them, without echoing values"
          : [
              leaked.length > 0
                ? `the allowlist was ABOLISHED, not extended: ${leaked.join(", ")} reached the child`
                : "",
              unannounced.length > 0
                ? `the announce mechanism went silent for: ${unannounced.join(", ")} — honoring six keys must not delete the drop report`
                : "",
              noisy.length > 0
                ? `the report named ambient host vars: ${noisy.join(", ")}`
                : "",
              leaksValue ? "the report ECHOED a dropped VALUE" : "",
            ]
              .filter(Boolean)
              .join("; "),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Clause (d) — CONTROL: the previously-working families still work.
  //
  // Passes PRE-fix by design. This is what distinguishes "the allowlist gained
  // six entries" from "the allowlist was rewritten and broke the deploy", and
  // it explicitly covers the #659 capture-health keys so this change cannot
  // regress the fix directly upstream of it.
  // -------------------------------------------------------------------------
  {
    const child = buildChildEnvironment(deployedEnv());
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["DB_HOST", "127.0.0.1"],
      ["DB_PASSWORD", "placeholder-db-password"],
      ["AUTH_TOKEN_ADMIN", "placeholder-admin"],
      ["AUTH_TOKEN_USER_RICO", "rico:placeholder-user-token"],
      ["OPENBRAIN_TRACING_ENABLED", "1"],
      ["OPENBRAIN_TRACING_SECRET_KEY", "placeholder-secret"],
      ["OPENBRAIN_CAPTURE_HEALTH_NAMESPACE", "rico"],
      ["OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS", "60000"],
      ["OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES", "360"],
    ];
    const broken = expected
      .filter(([key, value]) => child[key] !== value)
      .map(([key]) => key);
    clause(
      "d",
      broken.length === 0,
      broken.length === 0
        ? "control: DB_*, AUTH_TOKEN_*, AUTH_TOKEN_USER_*, OPENBRAIN_TRACING_* and the #659 OPENBRAIN_CAPTURE_HEALTH_* keys all still reach the child"
        : `REGRESSION: previously-delivered keys no longer reach the server child: ${broken.join(", ")}`,
    );
  }

  // -------------------------------------------------------------------------
  // Clause (e) — the three-state rule: unset / set-empty / set-valued.
  //
  // This is the clause amendment 29.2a added, and it is where the original
  // "all six" ruling came from: the reporter skipped only on `undefined`, so an
  // explicitly-EMPTY key — the documented clone-mode suppression form
  // (`docs/local-clone-dogfood.md:147`) — was announced as dropped
  // CONFIGURATION. A human read that boot line and filed an issue asking for a
  // prohibited key to be honored.
  //
  // The empty-means-suppressed semantic is NOT invented here: clone mode
  // already requires `QMD_PATH` to be explicitly empty to suppress the
  // production default (`src/local-clone-mode.ts:203-209`). This clause extends
  // that established three-state reading to the drop reporter.
  //
  // MUTATION PROOF, per round 9/18: the PASS half here comes from a negative
  // match ("empty is NOT announced"), which passes just as well on a reporter
  // that announces nothing at all. So both halves are asserted over the SAME
  // KEY NAME, differing only in VALUE STATE. That is the mutation — flip the
  // value from "" to a real string and the expected answer inverts. Run for the
  // real watchdog key AND a synthetic one, so what is proven is the value-state
  // rule rather than a name allowlist.
  // -------------------------------------------------------------------------
  {
    if (describeDropped === undefined) {
      clause("e", false, MISSING_REPORTER);
    } else {
      const probes = [SUPPRESSED_KEY, "OPENBRAIN_SOME_SUPPRESSIBLE_KEY"];
      const failures: string[] = [];
      for (const key of probes) {
        const emptyNames = describeDropped({
          ...deployedEnv(),
          [key]: "",
        }).map((entry) => entry.key);
        // The mutation: same key, same env, value flipped empty -> real.
        const valuedNames = describeDropped({
          ...deployedEnv(),
          [key]: "a-real-configured-value",
        }).map((entry) => entry.key);

        if (emptyNames.includes(key)) {
          failures.push(
            `${key}: explicitly-empty was ANNOUNCED as dropped configuration — ` +
              "a deliberate suppression reported as a mistake is the false positive that produced this issue",
          );
        }
        if (!valuedNames.includes(key)) {
          failures.push(
            `${key}: set-VALUED and unlisted was NOT announced — the reporter ` +
              "is skipping on falsiness or has gone silent; a real dropped configuration is invisible again",
          );
        }

        // "0" and "false" are values an operator CHOSE. Swallowing them would
        // be the silent drop this reporter exists to prevent, wearing the
        // suppression rule as a disguise.
        //
        // Honest note on what this does and does not prove. Mutating the fix to
        // `!configured` does NOT fail these probes, because `configured` is
        // `string | undefined`, `undefined` is skipped one line earlier, and
        // every non-empty STRING is truthy — `!"0"` is false. So `=== ""` and
        // `!configured` are equivalent mutants at this type, and no fixture can
        // separate them. These probes guard the reachable regression instead:
        // a future refactor that widens the value type, coerces, trims, or
        // reaches for a truthiness helper. Recorded rather than dressed up as a
        // mutation kill the check did not make.
        for (const falsy of ["0", "false"]) {
          const falsyNames = describeDropped({
            ...deployedEnv(),
            [key]: falsy,
          }).map((entry) => entry.key);
          if (!falsyNames.includes(key)) {
            failures.push(
              `${key}="${falsy}": a falsy-LOOKING but real configured value was ` +
                "treated as a suppression — the reporter is testing falsiness, not emptiness",
            );
          }
        }
      }
      clause(
        "e",
        failures.length === 0,
        failures.length === 0
          ? `three-state rule holds under mutation for ${probes.join(" and ")}: ` +
              "set-empty is a suppression (not announced), set-valued-and-unlisted is a drop (announced), unset is neither"
          : failures.join("; "),
      );
    }
  }

  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.ok);
  console.log();
  console.log(`clauses: ${results.length} run, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log(`failing: ${failed.map((f) => f.clause).join(", ")}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

// An exception escaping `main` must FAIL, loudly. Without this a top-level
// throw lets Bun print a trace and still exit 0 — a crashing subject banks a
// false GREEN (docs/lane-contract.md round 13; SME order 67).
main().catch((error: unknown) => {
  console.log();
  console.log(
    `FAIL  (driver) threw before completing: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});
