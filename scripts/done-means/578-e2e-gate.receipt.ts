#!/usr/bin/env bun
/**
 * Receipt reader for the #578 DONE-MEANS check. Not a test file; invoked by
 * `scripts/done-means/578-e2e-gate.sh`, which owns the verdict.
 *
 * Prints ONE requested field from a scenario-gate receipt:
 *
 *   scenario_count   number of scenarios the run actually executed
 *   teardown_failed  the receipt's teardown.failed tally
 *
 * WHY THIS IS A FILE AND NOT AN INLINE `bun -e`
 * ---------------------------------------------
 * The first version of this gate read the receipt with
 * `bun -e '<script>' -- "$PATH"` and defaulted to 0 via `|| echo 0`. `bun -e`
 * does NOT forward trailing arguments to the evaluated script — neither
 * `process.argv[2]` nor `Bun.argv[2]` is the path — so the snippet threw
 * `ERR_INVALID_ARG_TYPE` on EVERY run, the `|| echo 0` swallowed the crash,
 * and the gate reported "receipt reported 0 scenarios" for a receipt that
 * plainly contained three. That is a false FAIL from a silent crash, the exact
 * mirror of the false GREEN this repo keeps paying for (#583's vacuous
 * `secret_scan`; docs/lane-contract.md round 13's "top-level await with no
 * .catch exits 0").
 *
 * A real file takes real `Bun.argv`, and a missing/unreadable receipt is
 * reported as an explicit error with a non-zero exit instead of being
 * indistinguishable from a legitimately empty run.
 */

type Field = "scenario_count" | "teardown_failed";

async function main(): Promise<number> {
  const [, , receiptPath, field] = Bun.argv;
  if (!receiptPath || !field) {
    console.error("usage: 578-e2e-gate.receipt.ts <receipt.json> <field>");
    return 2;
  }

  const file = Bun.file(receiptPath);
  if (!(await file.exists())) {
    console.error(`receipt not found: ${receiptPath}`);
    return 1;
  }

  let receipt: Record<string, unknown>;
  try {
    receipt = (await file.json()) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`receipt is not readable JSON: ${message}`);
    return 1;
  }

  switch (field as Field) {
    case "scenario_count": {
      const scenarios = receipt.scenarios;
      if (!Array.isArray(scenarios)) {
        console.error("receipt has no `scenarios` array");
        return 1;
      }
      console.log(String(scenarios.length));
      return 0;
    }
    case "teardown_failed": {
      const teardown = receipt.teardown;
      if (!teardown || typeof teardown !== "object" || Array.isArray(teardown)) {
        console.error("receipt has no `teardown` object");
        return 1;
      }
      const failed = (teardown as Record<string, unknown>).failed;
      if (typeof failed !== "number") {
        console.error("receipt teardown has no numeric `failed` tally");
        return 1;
      }
      console.log(String(failed));
      return 0;
    }
    default:
      console.error(`unknown field: ${field}`);
      return 2;
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`receipt reader error: ${message}`);
      process.exitCode = 2;
    });
}
