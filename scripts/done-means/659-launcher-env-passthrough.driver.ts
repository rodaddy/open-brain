/**
 * DONE-MEANS driver for #659 — the local-clone launcher's child-environment
 * allowlist carries the capture-health keys, and ANNOUNCES every configured key
 * it drops instead of discarding it in silence.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT, AS OBSERVED
 * ---------------------------------------------------------------------------
 * PR #656 merged the capture-health observer wiring into `server/main.ts` and
 * ledger item 28 supplied the config ruling. `OPENBRAIN_CAPTURE_HEALTH_NAMESPACE`
 * was then set in the deployed clone's env file, the clone was redeployed with a
 * passing revision proof — and live `/health` still published no capture block,
 * because `buildChildEnvironment()` never handed the key to the server child.
 * The launcher process HAD the variable; the child it spawned did not.
 *
 * That is two defects, and this check asserts both:
 *
 *   1. The three `OPENBRAIN_CAPTURE_HEALTH_*` keys do not reach the child.
 *   2. The allowlist drops CONFIGURED keys with no signal at all, so every
 *      future server config key re-buys this same bug. That violates the repo
 *      coding standard "Nothing is adjusted silently" (operator ruling
 *      2026-08-08): a tool that transforms its input to satisfy a constraint
 *      announces the adjustment in its normal output.
 *
 * The SME KB already carries this exact class — `docs/sme/gotcha-agent.md`,
 * "An allowlist that drops unrecognized keys is accept-and-ignore, not
 * tolerance" (#464). Its first review question is the one this check enforces:
 * *does the drop path name what it dropped?* A count is unactionable at the
 * moment it matters; names cost one list. Its second is why clause (a) is a bug
 * in both directions: a dropped key that appears in the project's own constant
 * set is not an unknown future field, it is a supported concept the reader
 * forgot.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ALLOWLIST STAYS AN ALLOWLIST
 * ---------------------------------------------------------------------------
 * The launcher exists to hand the server child a tightly scoped environment —
 * `scripts/local-clone.test.ts` asserts `PATH`, `SSH_AUTH_SOCK` and a host
 * identity var never reach it. Passing the whole environment would fix #659 by
 * deleting the property the launcher was built for. Clause (d) is the control
 * that fails any such "fix": an unlisted junk key must still be dropped.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ANNOUNCEMENT IS SCOPED, AND WHY THAT SCOPE IS ITSELF ASSERTED
 * ---------------------------------------------------------------------------
 * `scripts/local-clone-autostart.sh:56-59` does `set -a; source local-clone.env`,
 * so the launcher's own environment is the env file UNIONED with launchd's
 * ambient environment. Announcing every dropped variable would name `PATH`,
 * `HOME`, `SSH_AUTH_SOCK` and dozens of others on every boot — noise that
 * teaches an operator to ignore the line, which is silence with extra steps.
 *
 * So the announcement is scoped to keys that look like Open Brain SERVER
 * configuration, and clause (e) asserts that scope from BOTH sides: an ambient
 * host variable is NOT announced, and a configured-looking one IS. A scope
 * rule with only its positive half tested passes just as well when the filter
 * is "announce nothing".
 *
 * No database, no network, no child process: `buildChildEnvironment` and
 * `describeDroppedChildEnvironment` are pure functions over a record. Clause
 * (f) drives the REAL `runLocalCloneLauncher` start path through its injected
 * boundaries so the announcement is proven to reach the launcher's actual
 * output, not merely to be computable in isolation.
 */
import {
  buildChildEnvironment,
  runLocalCloneLauncher,
  type LocalCloneLauncherDependencies,
} from "../local-clone.ts";
import {
  CAPTURE_HEALTH_NAMESPACE_ENV,
  CAPTURE_HEALTH_REFRESH_ENV,
  CAPTURE_HEALTH_WINDOW_ENV,
} from "../../server/capture/liveness-observer.ts";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

/**
 * A real directory for the clone-root fixture.
 *
 * `src/local-clone-mode.ts` requires OPENBRAIN_LOCAL_CLONE_ROOT to EXIST, and
 * clause (f) drives that validation for real. Repo-relative and gitignored
 * (`.gitignore:119`) rather than an absolute machine path — a hardcoded
 * `/Volumes/...` default died with EACCES on the Linux CI runner once already
 * (docs/lane-contract.md, #612 harvest).
 */
const CLONE_ROOT = fileURLToPath(
  new URL("../../_scratch/done-means-659-clone-root", import.meta.url),
);

const results: Array<{ clause: string; ok: boolean; detail: string }> = [];

function clause(name: string, ok: boolean, detail: string): void {
  results.push({ clause: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  (${name}) ${detail}`);
}

/**
 * The env the deployed clone actually runs with: the env file's keys unioned
 * with a handful of ambient launchd/shell variables. Values are placeholders —
 * this driver never connects to anything — but the KEY SET is the real one,
 * read from `/Volumes/ThunderBolt/open-brain-local/local-clone.env` on
 * 2026-08-08. A fixture whose key set is invented would prove nothing about the
 * deployment this issue is about (round 12: query the real distribution before
 * inventing a fixture shape).
 */
function deployedEnv(): Record<string, string | undefined> {
  return {
    // --- allowlisted today, must keep passing (clause c) ---
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
    // `src/local-clone-mode.ts:17-20` enforces it, and clause (f) drives the
    // real launcher through that validation.
    LOG_FILE: `${CLONE_ROOT}/logs/open-brain.log`,
    OPEN_BRAIN_BIND_HOST: "127.0.0.1",
    OPEN_BRAIN_MAINTENANCE_ENABLED: "1",
    OPEN_BRAIN_RUN_MIGRATIONS: "0",
    OPENBRAIN_LOCAL_CLONE: "1",
    OPENBRAIN_LOCAL_CLONE_ROOT: CLONE_ROOT,
    OPENBRAIN_RECOVERY_WAL_PATH: `${CLONE_ROOT}/recovery.wal`,
    OPENBRAIN_TRACING_ENABLED: "1",
    OPENBRAIN_TRACING_ENDPOINT: "http://tracing.invalid:3000",
    OPENBRAIN_TRACING_PUBLIC_KEY: "placeholder-public",
    OPENBRAIN_TRACING_SECRET_KEY: "placeholder-secret",
    OPENBRAIN_TRANSPORT: "http",
    PORT: "3100",
    // Clone mode requires QMD_PATH to be explicitly EMPTY, not merely unset
    // (`src/local-clone-mode.ts`). The deployed env file sets it the same way.
    QMD_PATH: "",

    // --- the #659 subject: configured, read by the serving tree, dropped ---
    [CAPTURE_HEALTH_NAMESPACE_ENV]: "rico",

    // --- ambient, must NEVER reach the child and must NOT be announced ---
    PATH: "/usr/bin:/bin",
    HOME: "/placeholder/home",
    SSH_AUTH_SOCK: "/placeholder/ssh-agent.sock",
  };
}

/**
 * A key that is not in the allowlist and never will be — the negative control.
 * Deliberately carries the `OPENBRAIN_` prefix so it also proves the fix did not
 * take the lazy route of passing an entire prefix family through.
 */
const JUNK_KEY = "OPENBRAIN_DEFINITELY_NOT_A_REAL_SERVER_KEY";

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
 * A static `import { describeDroppedChildEnvironment }` against the pre-fix
 * tree is a module-resolution SyntaxError: the driver dies before clause (a)
 * ever prints, and every clause "fails" without having measured anything. That
 * is a false RED — round 16's lesson, hit for real on this lane's first RED
 * run. Resolving the export at runtime means the pre-fix tree produces a clean,
 * per-clause, named RED and the surviving clauses still run.
 */
async function loadDropReporter(): Promise<DropReporter | undefined> {
  const module = (await import("../local-clone.ts")) as Record<string, unknown>;
  const reporter = module.describeDroppedChildEnvironment;
  return typeof reporter === "function"
    ? (reporter as DropReporter)
    : undefined;
}

/** Absent on the pre-fix tree; each dependent clause says so by name. */
const MISSING_REPORTER =
  "scripts/local-clone.ts exports no describeDroppedChildEnvironment — " +
  "the launcher has no way to report what it dropped (the #659 silent half)";

async function main(): Promise<void> {
  mkdirSync(CLONE_ROOT, { recursive: true });
  const describeDropped = await loadDropReporter();
  // -------------------------------------------------------------------------
  // Clause (a) — the three capture-health keys reach the child.
  //
  // The key NAMES come from the observer's own exported constants rather than
  // being retyped here. A driver that hardcodes the strings keeps passing when
  // the observer renames one, which is the same substring-superset trap round
  // 17 harvested: the clause must break when the subject moves.
  // -------------------------------------------------------------------------
  {
    const env = {
      ...deployedEnv(),
      [CAPTURE_HEALTH_WINDOW_ENV]: "360",
      [CAPTURE_HEALTH_REFRESH_ENV]: "60000",
    };
    const child = buildChildEnvironment(env);
    const missing = [
      CAPTURE_HEALTH_NAMESPACE_ENV,
      CAPTURE_HEALTH_WINDOW_ENV,
      CAPTURE_HEALTH_REFRESH_ENV,
    ].filter((key) => child[key] === undefined);
    clause(
      "a",
      missing.length === 0 &&
        child[CAPTURE_HEALTH_NAMESPACE_ENV] === "rico" &&
        child[CAPTURE_HEALTH_WINDOW_ENV] === "360" &&
        child[CAPTURE_HEALTH_REFRESH_ENV] === "60000",
      missing.length === 0
        ? `all three capture-health keys reach the server child with their configured values ` +
            `(namespace=${String(child[CAPTURE_HEALTH_NAMESPACE_ENV])})`
        : `capture-health keys DROPPED by the launcher: ${missing.join(", ")} — ` +
            `the merged #656 observer cannot go RUNNING on the deployed clone`,
    );
  }

  // -------------------------------------------------------------------------
  // Clause (b) — a configured-but-unlisted key is ANNOUNCED as dropped.
  //
  // Today this is silent, which is the half of #659 that keeps the bug
  // renewable. The announcement must NAME the key: a count tells the operator
  // something was ignored without saying what, which is unactionable at exactly
  // the moment it matters (SME #464).
  // -------------------------------------------------------------------------
  {
    const env = { ...deployedEnv(), [JUNK_KEY]: "configured-but-unlisted" };
    if (describeDropped === undefined) {
      clause("b", false, MISSING_REPORTER);
      clause("b:no-values", false, MISSING_REPORTER);
    } else {
      const dropped = describeDropped(env);
      const names = dropped.map((entry) => entry.key);
      clause(
        "b",
        names.includes(JUNK_KEY),
        names.includes(JUNK_KEY)
          ? `a configured-but-unlisted key is named in the launcher's drop report: ${JUNK_KEY}`
          : `configured key ${JUNK_KEY} was dropped SILENTLY — reported keys: ` +
              `${names.length === 0 ? "(none)" : names.join(", ")}`,
      );

      // The announcement must not leak the VALUE. The dropped set includes
      // secrets in the general case (an unlisted AUTH_TOKEN_* spelling would
      // land here), and this line goes to a log file the deploy runbook tells
      // an operator to read. Names are diagnostic; values are a credential leak.
      const serialized = JSON.stringify(dropped);
      clause(
        "b:no-values",
        !serialized.includes("configured-but-unlisted"),
        !serialized.includes("configured-but-unlisted")
          ? "the drop report names keys without echoing their values"
          : "the drop report ECHOES the dropped VALUE — a secret in an unlisted key would be logged",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Clause (c) — CONTROL: the families that already work still work.
  //
  // Passes PRE-fix by design. A check that fails everywhere proves only that it
  // fails (round 13); this is what distinguishes "the allowlist gained three
  // keys" from "the allowlist was rewritten and broke the deploy".
  // -------------------------------------------------------------------------
  {
    const child = buildChildEnvironment(deployedEnv());
    const ok =
      child.DB_PASSWORD === "placeholder-db-password" &&
      child.DB_HOST === "127.0.0.1" &&
      child.AUTH_TOKEN_ADMIN === "placeholder-admin" &&
      child.AUTH_TOKEN_USER_RICO === "rico:placeholder-user-token" &&
      child.OPENBRAIN_TRACING_ENABLED === "1" &&
      child.OPENBRAIN_TRACING_SECRET_KEY === "placeholder-secret";
    clause(
      "c",
      ok,
      ok
        ? "control: DB_*, AUTH_TOKEN_*, AUTH_TOKEN_USER_* and OPENBRAIN_TRACING_* all still reach the child"
        : "REGRESSION: a previously-passing env family no longer reaches the server child",
    );
  }

  // -------------------------------------------------------------------------
  // Clause (d) — CONTROL: the allowlist is still an allowlist.
  //
  // The ruling is "announced, not abolished". This fails any fix that passes
  // the whole environment through, and — because JUNK_KEY carries the
  // OPENBRAIN_ prefix — any fix that waves a whole prefix family through.
  // Also asserts the ambient host variables the launcher was built to strip.
  // -------------------------------------------------------------------------
  {
    const env = { ...deployedEnv(), [JUNK_KEY]: "configured-but-unlisted" };
    const child = buildChildEnvironment(env);
    const leaked = [JUNK_KEY, "PATH", "HOME", "SSH_AUTH_SOCK"].filter(
      (key) => child[key] !== undefined,
    );
    clause(
      "d",
      leaked.length === 0,
      leaked.length === 0
        ? `control: the allowlist holds — ${JUNK_KEY} and the ambient host vars are still excluded`
        : `the allowlist was ABOLISHED, not announced: ${leaked.join(", ")} reached the child`,
    );
  }

  // -------------------------------------------------------------------------
  // Clause (e) — MUTATION PROOF for the negative-match scope rule.
  //
  // Clause (b) passes on a filter that announces EVERYTHING, and clause (d)
  // does not constrain the report at all. Round 9: mutation-check any clause
  // whose PASS comes from a negative match — those pass both when the thing is
  // absent and when the check is broken. So the scope is asserted from both
  // sides in one clause: the ambient vars must NOT be announced (or the line
  // becomes boot noise an operator learns to skip) while the configured one
  // MUST be. A filter that announces nothing fails the first half; a filter
  // that announces everything fails the second.
  // -------------------------------------------------------------------------
  {
    const env = { ...deployedEnv(), [JUNK_KEY]: "configured-but-unlisted" };
    if (describeDropped === undefined) {
      clause("e", false, MISSING_REPORTER);
    } else {
      const names = describeDropped(env).map((e) => e.key);
      const noisy = ["PATH", "HOME", "SSH_AUTH_SOCK"].filter((key) =>
        names.includes(key),
      );
      const announcesSubject = names.includes(JUNK_KEY);
      clause(
        "e",
        noisy.length === 0 && announcesSubject,
        `scope, both directions: ambient host vars announced=${
          noisy.length === 0 ? "no" : noisy.join(",")
        }, configured unlisted key announced=${announcesSubject}` +
          (noisy.length === 0 && announcesSubject
            ? ""
            : " — an unscoped report is boot noise; an empty one is silence with extra steps"),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Clause (f) — CHAIN: the announcement reaches the LAUNCHER'S OWN OUTPUT.
  //
  // Clauses (a)-(e) prove the functions compute the right thing. This one
  // proves the start path actually SAYS it, by driving the real
  // `runLocalCloneLauncher` through its injected boundaries and capturing what
  // it reports. #656's done-means drove `createShadowApplication` directly and
  // so had this entire launcher seam outside its vantage — which is precisely
  // why #659 survived a passing check and a passing revision proof. A function
  // whose output nothing prints is the silent drop wearing a different hat.
  // -------------------------------------------------------------------------
  {
    const env = { ...deployedEnv(), [JUNK_KEY]: "configured-but-unlisted" };
    const announced: string[] = [];
    let spawnedEnv: Record<string, string> | undefined;

    const child = new EventEmitter() as ChildProcess;
    (child as { exitCode: number | null }).exitCode = null;
    (child as { signalCode: NodeJS.Signals | null }).signalCode = null;

    const deps: LocalCloneLauncherDependencies = {
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
          spawnedEnv = childEnv;
          queueMicrotask(() => child.emit("exit", 0, null));
          return child;
        },
      },
      writeReceipt: () => {},
      onSignal: () => () => {},
      // The announcement sink. Cast because the pre-fix
      // `LocalCloneLauncherDependencies` has no such member — driving the real
      // launcher is the point of this clause, and on the pre-fix tree the
      // absent sink is exactly what makes it RED rather than a type error that
      // stops the whole driver.
      announce: (line: string) => announced.push(line),
    } as LocalCloneLauncherDependencies;

    try {
      const code = await runLocalCloneLauncher("start", env, deps);
      const line = announced.join("\n");
      const namesSubject = line.includes(JUNK_KEY);
      const quietOnAmbient = !/\bPATH\b|\bSSH_AUTH_SOCK\b/.test(line);
      const reachedChild =
        spawnedEnv?.[CAPTURE_HEALTH_NAMESPACE_ENV] === "rico";
      clause(
        "f",
        code === 0 && namesSubject && quietOnAmbient && reachedChild,
        `chain: launcher exit=${code}, announced ${announced.length} line(s), ` +
          `names the dropped key=${namesSubject}, quiet on ambient=${quietOnAmbient}, ` +
          `capture namespace reached the spawned child=${reachedChild}` +
          (namesSubject
            ? ""
            : " — the drop is computable but the launcher never prints it"),
      );
    } catch (error: unknown) {
      clause(
        "f",
        false,
        `chain: the launcher start path threw before announcing: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
