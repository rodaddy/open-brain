/**
 * DONE-MEANS driver for #666 — the E2E scenario transport requests namespace
 * delegation when it spawns the provider.
 *
 * Not a test file; invoked by
 * scripts/done-means/666-transport-delegates-namespace.sh, which owns the
 * verdict.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS UNDER TEST, AND FROM WHICH SEAM
 * ---------------------------------------------------------------------------
 * `LiveScenarioTransport.executeProvider` spawns `uv run openbrain-memory`
 * with an env it builds inline. Since #657 the provider's namespace delegation
 * is opt-in and default OFF, and the transport ALWAYS derives a per-run
 * `eval-live-recall-*` namespace that no token grants by default — so without
 * OPENBRAIN_DELEGATE_NAMESPACE=1 the provider binds the token's own namespace
 * and refuses the configured one (the #662 error text). Ledger item 30.1 rules
 * that the TRANSPORT owns the delegation request, not `live-eval.env`.
 *
 * The subject is therefore the env dictionary that `Bun.spawn` actually
 * receives from the REAL `executeProvider` — not a helper extracted for
 * observability. `Bun.spawn` is stubbed for the duration of the call using the
 * repo's existing convention (`src/tools/__tests__/search-all.test.ts:85`,
 * `src/tools/__tests__/graph-evidence-consumers.test.ts:268`): the shipped
 * method runs unmodified and the stub records its second argument. Stubbing
 * the process boundary is what keeps the clause bound to the real call site
 * while needing no `uv`, no provider install, no network, and no credentials.
 *
 * ---------------------------------------------------------------------------
 * STUB-VS-LIVE COVERAGE SPLIT — READ THIS BEFORE CITING A GREEN
 * ---------------------------------------------------------------------------
 * This check proves the transport ASKS for delegation. It does NOT prove the
 * end-to-end capture works, and it cannot:
 *
 *   - `scripts/done-means/655-eval-teardown.driver.ts:116` supplies its own
 *     `ScenarioTransport` whose `executeProvider` writes direct SQL. The real
 *     spawn is never reached there, so #655's green never covered — and could
 *     never have caught — this defect. That is the coverage trap the verifier
 *     named (SME `injected_destination_bypasses_broken_composition`).
 *   - Here the spawn itself is stubbed, so the provider process, the
 *     X-Namespace header it sends, the server's role gate, and the durable row
 *     are all OUTSIDE this vantage point.
 *
 * The COMPOSED live proof stays exactly where it was: the #578 gate's
 * credentialed run, re-verified by the controller after this merges and PR
 * #653 syncs main again. This lane holds no credentials and harvests none.
 *
 * ---------------------------------------------------------------------------
 * CLAUSES
 * ---------------------------------------------------------------------------
 *   (a) The env passed to the real spawn contains OPENBRAIN_DELEGATE_NAMESPACE
 *       set to exactly "1". RED on origin/main: the key is absent entirely.
 *   (b) CONTROL — the four env keys the transport already set are unchanged:
 *       OPENBRAIN_BASE_URL / _TOKEN / _NAMESPACE / _PROJECT still carry their
 *       configured values, and the ambient process env still passes through.
 *       Passes PRE-fix by design (round 13: a check that fails everywhere
 *       proves only that it fails). This is the clause that fails if the fix
 *       replaces the env instead of adding one key to it.
 *   (c) MUTATION — clause (a) is re-run against the observed env with the
 *       delegation key stripped, and must FAIL there. Clause (a) is a
 *       single-key presence assertion, which is exactly the shape that passes
 *       for the wrong reason when the reader is looking at the wrong object.
 *
 * The mutant is applied to the OBSERVED env, not to the source file: deleting
 * the fix to prove RED is the round-16 "false RED by breaking the import"
 * hazard in another spelling, and an env-level mutant keeps RED regenerable
 * forever with the fix in place. It is honest about what it proves — that
 * clause (a) reads the delegation key specifically and fails on its absence —
 * and it is announced as such rather than presented as a source-level mutation.
 *
 * Output: clause names, states, and env KEY names. No OPENBRAIN_TOKEN value is
 * printed; the token fixture is a literal string invented here, and it is
 * still not echoed, because a driver that prints token values teaches the
 * wrong habit for the day one is real.
 */
import type { LiveEvalConfig } from "../../eval/open-brain/live/config.ts";
import { LiveScenarioTransport } from "../../eval/open-brain/live/scenario-transport.ts";

const MUTATE = process.env.DONE_MEANS_666_MUTATE === "1";

/**
 * Fixture config. `primaryNamespace` deliberately carries the real
 * `eval-live-recall-` prefix the gate derives per run: it is the foreign
 * namespace whose binding is the whole reason the delegation header is needed.
 */
const CONFIG: LiveEvalConfig = {
  baseUrl: "http://127.0.0.1:3100",
  primaryToken: "fixture-token-not-a-credential",
  negativeToken: "fixture-token-not-a-credential",
  negativeTokenIsDistinct: false,
  primaryNamespace: "eval-live-recall-donemeans666",
  negativeNamespace: "eval-live-recall-donemeans666-negative",
  project: "open-brain",
  searchMode: "hybrid",
  timeoutMs: 1000,
};

/** An ambient key planted in process.env to prove passthrough survives (b). */
const AMBIENT_KEY = "DONE_MEANS_666_AMBIENT";
const AMBIENT_VALUE = "ambient-passthrough-probe";

const DELEGATE_KEY = "OPENBRAIN_DELEGATE_NAMESPACE";

interface Clause {
  name: string;
  ok: boolean;
  detail: string;
}

const clauses: Clause[] = [];
function record(name: string, ok: boolean, detail: string): void {
  clauses.push({ name, ok, detail });
}

/**
 * Drive the REAL `executeProvider` with `Bun.spawn` stubbed, and return the env
 * record the shipped method handed to the process boundary.
 *
 * The stub returns the minimal shape `executeProvider` consumes — a writable
 * stdin, two readable streams, and an `exited` promise — so the method runs to
 * completion through its real `parseProviderOutput` path instead of throwing
 * somewhere that would hide which env it built. Exit 0 with empty stdout is
 * that function's documented empty-result path, so no receipt is fabricated.
 */
async function captureSpawnEnv(): Promise<Record<string, string>> {
  const originalSpawn = Bun.spawn;
  let captured: Record<string, string> | null = null;
  const encoder = new TextEncoder();

  (Bun as unknown as { spawn: unknown }).spawn = (
    _cmd: string[],
    options: { env?: Record<string, string> },
  ) => {
    captured = { ...(options.env ?? {}) };
    return {
      stdin: { write() {}, end() {} },
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(""));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
    };
  };

  try {
    // Neither the tool caller nor the pool is reached by executeProvider; both
    // are supplied through the constructor's own injection points as stubs so
    // that a future coupling fails loudly here instead of opening a socket.
    const transport = new LiveScenarioTransport(
      (() => {
        throw new Error("tool caller must not be reached by executeProvider");
      }) as never,
      CONFIG,
      { query: async () => ({ rows: [] }) } as never,
    );
    await transport.executeProvider({ operation: "capture" });
  } finally {
    (Bun as unknown as { spawn: unknown }).spawn = originalSpawn;
  }

  if (captured === null) {
    throw new Error("executeProvider did not reach Bun.spawn");
  }
  return captured;
}

/** Clause (a), factored so the mutation clause can re-run it verbatim. */
function delegationRequested(env: Record<string, string>): boolean {
  return env[DELEGATE_KEY] === "1";
}

async function main(): Promise<number> {
  process.env[AMBIENT_KEY] = AMBIENT_VALUE;
  const env = await captureSpawnEnv();

  // ---- (a) the delegation flag reaches the spawned provider ---------------
  const requested = delegationRequested(env);
  record(
    `(a) spawn env sets ${DELEGATE_KEY}=1`,
    requested,
    requested
      ? `${DELEGATE_KEY} present with value "1"`
      : DELEGATE_KEY in env
        ? `${DELEGATE_KEY} present but not "1"`
        : `${DELEGATE_KEY} absent from the spawn env`,
  );

  // ---- (b) CONTROL: the four existing keys and passthrough are unchanged --
  const expected: Array<[string, string]> = [
    ["OPENBRAIN_BASE_URL", CONFIG.baseUrl],
    ["OPENBRAIN_TOKEN", CONFIG.primaryToken],
    ["OPENBRAIN_NAMESPACE", CONFIG.primaryNamespace],
    ["OPENBRAIN_PROJECT", CONFIG.project],
  ];
  const wrong = expected
    .filter(([key, value]) => env[key] !== value)
    .map(([key]) => key);
  const passthroughOk = env[AMBIENT_KEY] === AMBIENT_VALUE;
  record(
    "(b) CONTROL: four existing keys unchanged + ambient passthrough intact",
    wrong.length === 0 && passthroughOk,
    wrong.length === 0 && passthroughOk
      ? "OPENBRAIN_BASE_URL/_TOKEN/_NAMESPACE/_PROJECT carry configured values; ambient key passed through"
      : `wrong-or-missing keys: ${wrong.join(", ") || "none"}; ambient passthrough: ${passthroughOk}`,
  );

  // ---- (c) MUTATION: strip the key, clause (a) must fail ------------------
  const mutant = { ...env };
  delete mutant[DELEGATE_KEY];
  const mutantSurvives = delegationRequested(mutant);
  record(
    "(c) MUTATION: clause (a) fails when the delegation key is stripped",
    !mutantSurvives,
    mutantSurvives
      ? "clause (a) still passed without the key — it is not reading the key"
      : "clause (a) correctly failed on the stripped env",
  );

  if (MUTATE) {
    // Escape hatch for a human re-proving the mutation by hand: report clause
    // (a) AS the mutant and nothing else, so the transcript shows the intended
    // failure rather than a green run that merely claims one happened.
    console.log(
      `INFO  DONE_MEANS_666_MUTATE=1 — reporting clause (a) against the env with ${DELEGATE_KEY} stripped`,
    );
    const ok = delegationRequested(mutant);
    console.log(`MUTANT clause (a) => ${ok ? "PASS (BAD)" : "FAIL (expected)"}`);
    return ok ? 1 : 0;
  }

  for (const clause of clauses) {
    console.log(
      `${clause.ok ? "PASS" : "FAIL"}  ${clause.name} — ${clause.detail}`,
    );
  }
  const failed = clauses.filter((clause) => !clause.ok).length;
  console.log(`\nclauses: ${clauses.length}  failed: ${failed}`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`FAIL  driver error: ${(error as Error).message}`);
    process.exit(2);
  },
);
