#!/usr/bin/env bun
/**
 * Receipt reader for the #578 DONE-MEANS check. Not a test file; invoked by
 * `scripts/done-means/578-e2e-gate.sh`, which owns the verdict.
 *
 * Prints ONE requested field from a scenario-gate receipt:
 *
 *   scenario_count            number of scenarios the run actually executed
 *   teardown_residue_checked  "true"/"false" — whether residue was OBSERVED
 *   teardown_residue_rows     rows still present after teardown
 *   teardown_residue_tables   "table=count,table=count" (empty when none)
 *   teardown_failed           the receipt's teardown.failed tally (DIAGNOSTIC
 *                             ONLY — see below)
 *
 * WHY THE TALLY IS NO LONGER THE VERDICT
 * --------------------------------------
 * `teardown.failed` counts cleanup CALLS that threw, not rows left behind.
 * PR #673 (issue #671) established that a teardown reporting FAILURE is not
 * evidence of residue: on the third credentialed #653 verify, two
 * `archive_entry` calls threw while a 12-table residue query returned zero
 * rows, and this gate's clause (e) failed a database that was in fact clean.
 * The SME entry is
 * `docs/sme/entries/2026-08-08-a-teardown-that-reports-failure-is-not-evidence-of-residue.md`:
 * "the verdict reads the OBSERVABLE, not the attempt log," and "'not observed'
 * is not 'clean'."
 *
 * So clause (e) now reads `receipt.teardown_residue` — an actual count of
 * remaining rows, produced by a reader that shares the purge's own table tuple
 * — and reports the tally as diagnostics. `checked` is surfaced as its OWN
 * field, deliberately: `rows` is 0 both when nothing remains and when nothing
 * was looked at, so a clause that read only `rows` would turn the false red
 * into a false green. The clause fails closed on `checked=false`.
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

type Field =
  | "scenario_count"
  | "teardown_failed"
  | "teardown_residue_checked"
  | "teardown_residue_rows"
  | "teardown_residue_tables";

/**
 * Pull `receipt.teardown_residue` out, or return an error string.
 *
 * A receipt with NO `teardown_residue` at all is an error, never a default.
 * Defaulting a missing residue reading to `{checked:true, rows:0}` would make
 * an OLD receipt — one written before #673 shipped the field — silently pass
 * the clause that exists to read it, which is the same unperformed-check
 * verdict in a new spelling.
 */
function readResidue(
  receipt: Record<string, unknown>,
): Record<string, unknown> | string {
  const residue = receipt.teardown_residue;
  if (!residue || typeof residue !== "object" || Array.isArray(residue)) {
    return "receipt has no `teardown_residue` object (pre-#673 receipt, or the gate did not emit one)";
  }
  return residue as Record<string, unknown>;
}

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
    case "teardown_residue_checked": {
      const residue = readResidue(receipt);
      if (typeof residue === "string") {
        console.error(residue);
        return 1;
      }
      const checked = residue.checked;
      if (typeof checked !== "boolean") {
        console.error("teardown_residue has no boolean `checked` flag");
        return 1;
      }
      // Printed even when false, with the reason on stderr, so the transcript
      // says WHY the clause is about to fail closed rather than only that it
      // did.
      if (!checked) {
        const reason = residue.unchecked_reason;
        console.error(
          `residue was NOT observed: ${typeof reason === "string" && reason ? reason : "no reason given"}`,
        );
      }
      console.log(checked ? "true" : "false");
      return 0;
    }
    case "teardown_residue_rows": {
      const residue = readResidue(receipt);
      if (typeof residue === "string") {
        console.error(residue);
        return 1;
      }
      const rows = residue.rows;
      if (typeof rows !== "number" || !Number.isFinite(rows)) {
        console.error("teardown_residue has no numeric `rows` count");
        return 1;
      }
      console.log(String(rows));
      return 0;
    }
    case "teardown_residue_tables": {
      const residue = readResidue(receipt);
      if (typeof residue === "string") {
        console.error(residue);
        return 1;
      }
      const byTable = residue.by_table;
      if (!byTable || typeof byTable !== "object" || Array.isArray(byTable)) {
        console.error("teardown_residue has no `by_table` object");
        return 1;
      }
      // Empty is a legitimate answer (nothing remains), so this prints an
      // empty line and exits 0 rather than erroring — the caller decides what
      // emptiness means, using `rows`.
      console.log(
        Object.entries(byTable as Record<string, unknown>)
          .map(([table, count]) => `${table}=${String(count)}`)
          .join(","),
      );
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
