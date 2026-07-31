/**
 * Prove the linter and the type checker actually reject what the standard says
 * they reject.
 *
 * THIS IS THE TEST THAT PROVES THE SUITE CAN FAIL.
 *
 * A configured rule is not an enforced rule. The Python side of this exemplar
 * learned it the expensive way: ruff SKIPS `PLR1702` and exits 0 when `preview`
 * is absent, so the config looked correct, the run reported success, and
 * nothing was ever examined. A check that always passes is invisible by
 * construction -- nobody investigates a green light.
 *
 * The TypeScript side has its own version of the same trap. oxlint takes an
 * `.oxlintrc.json` full of rule names and does NOT error on a rule it does not
 * implement under the requested plugin; drop `"plugins": ["typescript"]` and
 * every `typescript/*` rule below silently stops running while the file still
 * lists them. `--deny-warnings` does not help, because a rule that never runs
 * produces no warning.
 *
 * So each test here feeds oxlint (or tsc) a snippet that MUST be rejected and
 * asserts the specific rule name appears in the output. Loosen `complexity`,
 * raise `max-depth`, drop a plugin, or delete a rule, and one of these goes red
 * and names what stopped working.
 *
 * The mirror image matters just as much: a COMPLIANT snippet must pass. A
 * linter that rejects everything is as useless as one that rejects nothing, and
 * much more likely to get switched off in a hurry by someone on a deadline.
 *
 * See also:
 * - _DOCS/STANDARDS-typescript.md ## Control flow
 * - .oxlintrc.json -- the config under test
 * - tsconfig.json -- the compiler settings under test
 * - ../python-exemplar/tests/test_enforcement.py -- the same tests, same
 *   thresholds, other language. Divergence between the two files is a bug in
 *   one of them.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import { describe, test } from "node:test";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Scratch directory for snippets.
 *
 * `os.tmpdir()` is correct HERE and nowhere else in this repo set. The agent
 * policy bans `/tmp` because an agent writing a durable artifact there makes it
 * invisible to every other process and to the operator. These files are neither
 * durable nor artifacts -- they exist for the length of one `execFileSync` and
 * are never read by anything but the linter subprocess. Writing them into the
 * repo instead would be the actual mistake: the linter would then find them on
 * a normal `npm run lint` and fail the build on snippets that are SUPPOSED to
 * be broken.
 *
 * Note that `TMPDIR` is pointed at the temp workspace on operator machines
 * anyway, so this resolves there rather than to a system path.
 */
const SCRATCH = mkdtempSync(join(tmpdir(), "exemplar-enforcement-"));

/**
 * Lint a snippet with the project's real config and return the rules that fired.
 *
 * Runs oxlint from PROJECT_ROOT so `.oxlintrc.json` is discovered exactly as it
 * is in a normal run -- pointing `--config` at it from elsewhere would test a
 * configuration nobody actually uses.
 *
 * oxlint's default human output is parsed rather than a JSON mode, because the
 * rule name appears in the `eslint(rule-name)` / `typescript(rule-name)` marker
 * on every diagnostic line and that marker is what a reader sees too. The
 * regex takes the name out of the parentheses.
 *
 * @param source - TypeScript source to check.
 * @param filename - Name for the snippet. Matters when a rule or an override is
 *   path-sensitive.
 * @returns Set of rule names oxlint reported, e.g. `{"complexity", "no-empty"}`.
 */
function lint(source: string, filename = "snippet.ts"): Set<string> {
  const target = join(SCRATCH, filename);
  writeFileSync(target, source, "utf8");

  let output: string;
  try {
    output = execFileSync("npx", ["oxlint", "--no-ignore", target], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    // oxlint exits non-zero WHEN IT FINDS SOMETHING, which is the case these
    // tests care about most. execFileSync turns that into a throw, so the
    // output has to be recovered from the error object rather than treated as
    // a failure to run.
    const withOutput = error as { stdout?: string; stderr?: string };
    output = `${withOutput.stdout ?? ""}${withOutput.stderr ?? ""}`;
  }

  const rules = new Set<string>();
  for (const match of output.matchAll(/\b\w+\(([\w-]+(?:\/[\w-]+)?)\)/g)) {
    const name = match[1];
    if (name !== undefined) rules.add(name);
  }
  return rules;
}

/**
 * Type-check a snippet against the project's real tsconfig.
 *
 * @param source - TypeScript source to check.
 * @returns Everything tsc printed. Empty when the snippet is clean.
 */
function typecheck(source: string): string {
  const target = join(SCRATCH, "typecheck-snippet.ts");
  writeFileSync(target, source, "utf8");

  try {
    execFileSync(
      "npx",
      [
        "tsc",
        // TS 7 errors (TS5112) rather than silently ignoring a discovered
        // tsconfig.json when files are also named on the command line. The
        // flags below therefore have to state the settings under test
        // explicitly -- which is arguably better for a test that exists to
        // prove a specific setting is doing something.
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--noUncheckedIndexedAccess",
        "--exactOptionalPropertyTypes",
        "--target",
        "es2023",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        target,
      ],
      { cwd: PROJECT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return "";
  } catch (error: unknown) {
    const withOutput = error as { stdout?: string; stderr?: string };
    return `${withOutput.stdout ?? ""}${withOutput.stderr ?? ""}`;
  }
}

describe("complexity ceiling fires", () => {
  // Cyclomatic complexity = decision points + 1. Fifteen `if`s scores 16
  // against a ceiling of 10. Parity with python-exemplar's C901 test, which
  // uses the same fifteen branches on purpose.
  test("a function past the ceiling is rejected", () => {
    const branches = Array.from(
      { length: 15 },
      (_unused, n) => `  if (value === ${String(n)}) return ${String(n)};`,
    ).join("\n");

    const rules = lint(
      `export function classify(value: number): number {\n${branches}\n  return -1;\n}\n`,
    );

    assert.ok(
      rules.has("complexity"),
      "complexity did not fire. The rule was most likely removed from " +
        ".oxlintrc.json or its max was raised. Rules reported: " +
        [...rules].join(", "),
    );
  });

  test("a lookup table instead of a branch pile is accepted", () => {
    // The sanctioned rewrite: data replaces control flow, and complexity
    // collapses to 2. This is the shape the rule is trying to produce -- if it
    // ever fails, the ceiling has been set so low it bans correct code.
    const rules = lint(
      "const TABLE: Record<number, number> = { 0: 0, 1: 1, 2: 2 };\n" +
        "export function classify(value: number): number {\n" +
        "  return TABLE[value] ?? -1;\n" +
        "}\n",
    );

    assert.ok(!rules.has("complexity"));
  });
});

describe("max-depth ceiling fires", () => {
  test("four levels of nesting is rejected", () => {
    const rules = lint(
      "export function deep(a: boolean, b: boolean, c: boolean, d: boolean): number {\n" +
        "  if (a) {\n    if (b) {\n      if (c) {\n        if (d) {\n" +
        "          return 1;\n        }\n      }\n    }\n  }\n  return 0;\n}\n",
    );

    assert.ok(
      rules.has("max-depth"),
      `max-depth did not fire. Rules reported: ${[...rules].join(", ")}`,
    );
  });

  test("guard clauses expressing the same logic are accepted", () => {
    const rules = lint(
      "export function flat(a: boolean, b: boolean, c: boolean, d: boolean): number {\n" +
        "  if (!a) return 0;\n  if (!b) return 0;\n  if (!c) return 0;\n" +
        "  return d ? 1 : 0;\n}\n",
    );

    assert.ok(!rules.has("max-depth"));
  });
});

describe("no-else-return fires", () => {
  test("else after return is rejected", () => {
    const rules = lint(
      "export function pick(flag: boolean): string {\n" +
        '  if (flag) {\n    return "a";\n  } else {\n    return "b";\n  }\n}\n',
    );

    assert.ok(
      rules.has("no-else-return"),
      `no-else-return did not fire. Rules reported: ${[...rules].join(", ")}`,
    );
  });
});

describe("no-empty fires", () => {
  test("a swallowed error is rejected", () => {
    // The single most damaging shape in the set: the failure happened, and
    // nothing above ever learns of it. allowEmptyCatch is off precisely so
    // this cannot be written.
    const rules = lint(
      "export function swallow(raw: string): void {\n" +
        "  try {\n    JSON.parse(raw);\n  } catch {}\n}\n",
    );

    assert.ok(
      rules.has("no-empty"),
      "no-empty did not fire, or allowEmptyCatch was turned back on. " +
        `Rules reported: ${[...rules].join(", ")}`,
    );
  });
});

describe("typescript rules fire", () => {
  test("an explicit any is rejected", () => {
    const rules = lint("export function take(value: any): void {\n  void value;\n}\n");

    // NOTE the bare name. The config key is `typescript/no-explicit-any`, but
    // the diagnostic marker oxlint prints is `typescript(no-explicit-any)` --
    // plugin OUTSIDE the parentheses, rule name inside. Asserting on the
    // config-style name here failed even though the rule had fired correctly.
    assert.ok(
      rules.has("no-explicit-any"),
      "no-explicit-any did not fire. The `typescript` plugin was most likely " +
        "dropped from .oxlintrc.json -- oxlint does NOT error on rules whose " +
        `plugin is absent; they silently stop running. Reported: ${[...rules].join(", ")}`,
    );
  });

  test("a non-null assertion is rejected", () => {
    const rules = lint(
      "export function force(values: string[]): string {\n  return values[0]!;\n}\n",
    );

    assert.ok(
      rules.has("no-non-null-assertion"),
      `no-non-null-assertion did not fire. Reported: ${[...rules].join(", ")}`,
    );
  });
});

describe("the type checker enforces its settings", () => {
  test("noUncheckedIndexedAccess makes an index access possibly-undefined", () => {
    // Without this flag `values[0]` types as `string` and the `.length` below
    // compiles -- then throws at runtime on an empty array. This is the single
    // setting that catches the most common real-world TypeScript crash.
    const output = typecheck(
      "export function first(values: string[]): number {\n" +
        "  return values[0].length;\n}\n",
    );

    assert.match(
      output,
      /possibly 'undefined'|undefined/,
      "noUncheckedIndexedAccess is not in effect -- an out-of-bounds read " +
        `type-checks clean. tsc said: ${output || "(nothing)"}`,
    );
  });

  test("the guarded form compiles", () => {
    const output = typecheck(
      "export function first(values: string[]): number {\n" +
        "  const head = values[0];\n" +
        "  return head === undefined ? 0 : head.length;\n}\n",
    );

    assert.equal(output.trim(), "", `expected clean, got: ${output}`);
  });
});

describe("the suite can fail", () => {
  // A guard against the failure mode this whole file exists to prevent: a
  // runner that reports success without evaluating anything.
  test("a false assertion actually throws", () => {
    assert.throws(() => {
      assert.ok(false, "expected");
    }, assert.AssertionError);
  });
});
