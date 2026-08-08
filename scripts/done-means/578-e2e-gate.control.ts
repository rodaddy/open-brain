#!/usr/bin/env bun
/**
 * Control-clause driver for the #578 DONE-MEANS check. Not a test file; invoked
 * by `scripts/done-means/578-e2e-gate.sh`, which owns the verdict.
 *
 * WHAT IT DOES
 * ------------
 * Reads the real scenario fixture and writes a copy carrying ONE deliberately
 * wrong expectation, so the gate can prove the scenario suite still FAILS when
 * reality and the expectation disagree.
 *
 * WHY THIS PARTICULAR MUTATION
 * ----------------------------
 * The mutation has to satisfy two opposing constraints, and most candidates
 * fail one of them:
 *
 *   1. The fixture must still LOAD. `eval/open-brain/live/scenario-fixtures.ts`
 *      validates with Zod and additionally rejects non-contract scope keys
 *      (`assertScopeKeys`, scenario-fixtures.ts:26-31). A mutation that trips
 *      the loader makes the runner exit non-zero for a PARSE error, and the
 *      gate would read that as "the suite discriminates" when in fact the suite
 *      never ran. That is a false green for the control clause itself, which is
 *      strictly worse than having no control clause.
 *
 *   2. The expectation must be UNSATISFIABLE BY BEHAVIOUR, not by construction,
 *      so that what fails is an OUTPUT COMPARISON — the exact machinery the
 *      gate is claiming works.
 *
 * `durable_memory_shape.expected.min_items` satisfies both. The schema accepts
 * any positive integer (`z.number().int().min(1)`,
 * scenario-fixtures.ts:100), so the fixture loads cleanly; and the gate
 * enforces it against the ACTUAL recalled item count
 * (`scenario-gate.ts:255`, via `durableSectionChecks`). The scenario seeds
 * exactly one record, so demanding a large count is a claim about observed
 * output that cannot hold — while every other scenario in the file is left
 * untouched and keeps exercising the real path.
 *
 * Deliberately NOT used as the mutation:
 *   - a bad scope key — rejected by the loader (parse error, see constraint 1);
 *   - a corrupted `schema_version` — same problem;
 *   - deleting scenarios — an empty suite is a DIFFERENT defect, and the gate
 *     already checks the scenario count separately in clause (a).
 *
 * OUTPUT
 * ------
 * Writes the mutated fixture to `--out` and prints the single field it changed.
 * Exits non-zero if the input does not contain the scenario it needs to mutate,
 * rather than silently emitting an unmutated copy — an unmutated copy would
 * PASS the suite and be reported as "the suite accepted a wrong expectation",
 * inverting the clause's meaning.
 */

interface FixtureShape {
  scenarios?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Absurdly high vs. the single record the scenario seeds. */
const IMPOSSIBLE_MIN_ITEMS = 9_999;

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = Bun.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = Bun.argv.indexOf(`--${name}`);
  const next = index >= 0 ? Bun.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

async function main(): Promise<number> {
  const inPath = argValue("in");
  const outPath = argValue("out");
  if (!inPath || !outPath) {
    console.error("usage: 578-e2e-gate.control.ts --in <fixture> --out <path>");
    return 2;
  }

  const fixture = (await Bun.file(inPath).json()) as FixtureShape;
  const scenarios = Array.isArray(fixture.scenarios) ? fixture.scenarios : [];

  const target = scenarios.find(
    (scenario) => scenario.kind === "durable_memory_shape",
  );
  if (!target) {
    console.error(
      "control driver: no durable_memory_shape scenario in the fixture; refusing to emit an unmutated copy",
    );
    return 1;
  }

  const expected = target.expected;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    console.error(
      "control driver: durable_memory_shape scenario has no `expected` object to mutate",
    );
    return 1;
  }

  const before = (expected as Record<string, unknown>).min_items;
  (expected as Record<string, unknown>).min_items = IMPOSSIBLE_MIN_ITEMS;

  // The fixture id is changed too so a stray receipt can never be mistaken for
  // a real run's (docs/lane-contract.md: nothing silent — the artifact says
  // what it is).
  fixture.fixture_id = `${String(fixture.fixture_id ?? "unknown")}-CONTROL-WRONG-EXPECTATION`;

  await Bun.write(outPath, `${JSON.stringify(fixture, null, 2)}\n`);

  console.log(
    `control driver: scenario=${String(target.id)} field=expected.min_items ${String(before)} -> ${IMPOSSIBLE_MIN_ITEMS} (deliberately unsatisfiable)`,
  );
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`control driver error: ${message}`);
      process.exitCode = 2;
    });
}
