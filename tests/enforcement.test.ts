/**
 * Prove the linter and the type checker actually reject what the standard says
 * they reject.
 *
 * THIS IS THE TEST THAT PROVES THE SUITE CAN FAIL.
 *
 * A configured rule is not an enforced rule. The Python side of the exemplar
 * learned it the expensive way: ruff SKIPS `PLR1702` and exits 0 when `preview`
 * is absent, so the config looked correct, the run reported success, and
 * nothing was ever examined. A check that always passes is invisible by
 * construction -- nobody investigates a green light.
 *
 * The TypeScript side has its own version of the same trap. oxlint takes an
 * `.oxlintrc.json` full of rule names and does NOT error on a rule it does not
 * implement under the requested plugin; drop `"plugins": ["typescript"]` and
 * every `typescript/*` rule silently stops running while the file still lists
 * them. `--deny-warnings` does not help, because a rule that never runs
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
 * PORTED FROM `_DOCS/typescript-exemplar/tests/enforcement.test.ts`, with two
 * deliberate deltas for this repo:
 *   1. `bun:test` rather than `node:test` + `node:assert` -- open-brain runs on
 *      bun (a Node 24 migration is filed as #751 and is not this file's job).
 *   2. Scratch snippets go under `{temp_workspace}/open-brain/_scratch/`, never
 *      `os.tmpdir()`. `/tmp` and `$TMPDIR` are sandbox-local: a runner, a Codex
 *      sandbox, and the host each see a different one. The exemplar's
 *      `mkdtempSync(tmpdir())` is the one line of it that does not port.
 *
 * See also:
 * - `_DOCS/STANDARDS-typescript.md` ## Control flow
 * - `.oxlintrc.json` -- the config under test, owned by another lane
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Repo root. `import.meta.dir` is this file's directory (`<root>/tests`), so
 * one level up is the root that holds `.oxlintrc.json`.
 */
const PROJECT_ROOT = resolve(import.meta.dir, "..");

/**
 * The config under test. Another lane owns this file. When it is absent every
 * lint assertion below is meaningless -- oxlint would fall back to its own
 * defaults and a green run would prove nothing about OUR ceilings -- so the
 * suite SKIPS loudly rather than passing on a config nobody wrote.
 */
const OXLINT_CONFIG = join(PROJECT_ROOT, ".oxlintrc.json");
const CONFIG_PRESENT = existsSync(OXLINT_CONFIG);

/**
 * Scratch directory for snippets.
 *
 * NOT `os.tmpdir()`, and not the repo. The repo is wrong because a normal lint
 * run would then find these deliberately-broken files and fail the build on
 * them; `/tmp` is wrong because it is sandbox-local and invisible to every
 * other process. The temp workspace is the sanctioned third option.
 *
 * The workspace root is resolved from the environment because the hard-coded
 * `/Volumes/...` path is a Mac-only volume and a Linux CI runner cannot create
 * it. `RUNNER_TEMP` is accepted first on CI: the runner owns that directory for
 * the life of the job and nothing else reads it, so it carries none of the
 * cross-process invisibility that rules out `/tmp`.
 *
 * The directory is created in `beforeAll` rather than at module load so that
 * merely importing this file can never throw.
 */
const SCRATCH = join(
  process.env.RUNNER_TEMP ??
    process.env.OPENBRAIN_TEMP_WORKSPACE ??
    "/Volumes/ThunderBolt/_tmp/open-brain",
  "_scratch/enforcement",
);

beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true });
});

/** Counter backing `lint`'s unique default snippet name. See `lint`. */
let nextSnippetId = 0;

/**
 * Fixtures that are checked into the repo rather than generated.
 *
 * `.oxlintrc.json` carries no override for this path and the files use a `.txt`
 * suffix, so a normal `oxlint` run over the repo never picks them up as source.
 * They exist so a human can read the exact shape each ceiling rejects without
 * running the suite.
 */
const FIXTURES = join(PROJECT_ROOT, "tests/fixtures/enforcement");

/**
 * Read a checked-in fixture.
 *
 * @param name - File name under `tests/fixtures/enforcement/`.
 * @returns The fixture's source text.
 */
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/**
 * Lint a snippet with the project's real config and return the rules that fired.
 *
 * Runs oxlint from PROJECT_ROOT so `.oxlintrc.json` is discovered exactly as it
 * is in a normal run -- pointing `--config` at it from elsewhere would test a
 * configuration nobody actually uses.
 *
 * oxlint's default human output is parsed rather than a JSON mode, because the
 * rule name appears in the `eslint(rule-name)` / `typescript(rule-name)` marker
 * on every diagnostic line and that marker is what a reader sees too. The regex
 * takes the name out of the parentheses.
 *
 * @param source - TypeScript source to check.
 * @param filename - Name for the snippet. Matters when a rule or an override is
 *   path-sensitive.
 * @returns Set of rule names oxlint reported, e.g. `{"complexity", "no-empty"}`.
 */
function lint(source: string, filename?: string): Set<string> {
  // UNIQUE PER CALL BY DEFAULT. Every test used to write the same
  // `snippet.ts`, and bun runs the tests in a file concurrently -- so one test
  // overwrote another's snippet between `writeFileSync` and oxlint reading it.
  // The symptom is maximally confusing: `max-params DID NOT FIRE ...; reported:
  // no-else-return`, i.e. the rules of whichever snippet won the race. Callers
  // that care about the name (path-sensitive rules/overrides) still pass one.
  const target = join(SCRATCH, filename ?? `snippet-${String(nextSnippetId++)}.ts`);
  writeFileSync(target, source, "utf8");

  let output: string;
  try {
    output = execFileSync("bunx", ["oxlint", "--no-ignore", target], {
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
 * Assert a rule fired, with a message that names what probably broke.
 *
 * A bare `expect(rules.has(x)).toBe(true)` tells the next reader that something
 * is false and nothing about which knob to look at, so every ceiling assertion
 * goes through here.
 *
 * @param rules - What `lint` reported.
 * @param rule - The rule name that must be present.
 * @param hint - What most likely changed in `.oxlintrc.json`.
 */
function expectFired(rules: Set<string>, rule: string, hint: string): void {
  expect(
    rules.has(rule)
      ? rule
      : `${rule} DID NOT FIRE (${hint}); reported: ${[...rules].join(", ") || "nothing"}`,
  ).toBe(rule);
}

/**
 * Read the live ceiling for a numeric rule out of oxlint's own resolved config.
 *
 * THIS IS WHY THE TESTS DO NOT HARDCODE NUMBERS. `.oxlintrc.json` in this repo
 * is a RATCHET, not the exemplar's aspirational set: the ceilings were
 * calibrated to what open-brain's existing source already does (measured
 * 2026-08-25 -- complexity 130, max-lines 1850, max-lines-per-function 540,
 * max-params 11, max-depth 5) so the linter goes green on day one and gets
 * tightened over time. A fixture sized against the exemplar's numbers would
 * pass cleanly here and the test would report success while proving nothing.
 *
 * So each fixture is generated to exceed whatever the ceiling is RIGHT NOW.
 * Tighten a ratchet and these tests keep testing; the only thing that turns
 * them red is a rule being removed, disabled, or its plugin dropped -- which
 * is exactly the failure this file exists to catch.
 *
 * @param rule - Rule name as it appears in the config, e.g. `max-params`.
 * @returns The configured `max`, or `undefined` if the rule is absent/off.
 */
function ceiling(rule: string): number | undefined {
  const raw = execFileSync("bunx", ["oxlint", "--print-config"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const entry = (JSON.parse(raw) as { rules?: Record<string, unknown> }).rules?.[rule];
  if (!Array.isArray(entry)) return undefined;

  // Shape is ["deny", [{ max: N }]] -- severity, then an array of option objects.
  const options = entry[1];
  const first = Array.isArray(options) ? options[0] : options;
  const max = (first as { max?: unknown } | undefined)?.max;
  return typeof max === "number" ? max : undefined;
}

/**
 * Assert a numeric ceiling is configured at all before sizing a fixture past it.
 *
 * A missing ceiling means the rule was deleted or switched off, which is the
 * headline failure -- reported here rather than as a confusing `NaN` fixture.
 *
 * @param rule - Rule name to look up.
 * @returns The configured max.
 */
function requireCeiling(rule: string): number {
  const max = ceiling(rule);
  expect(
    max === undefined
      ? `${rule} HAS NO CEILING -- removed or disabled in .oxlintrc.json`
      : "configured",
  ).toBe("configured");
  return max as number;
}

/**
 * Build one heavily-commented function: six comment lines, then a three-line
 * body. Lives at module scope so the caller stays inside the repo's own
 * `max-nested-callbacks` ceiling -- a test that proves the ceilings fire has
 * no business tripping one.
 *
 * @param n - Index used to name the function and its return value.
 * @returns Source for a single documented function.
 */
function documentedFunction(n: number): string {
  const notes = Array.from(
    { length: 6 },
    (_unused, c) => `// note ${String(c)} for fn${String(n)}`,
  ).join("\n");

  return `${notes}\nexport function fn${String(n)}(): number {\n  return ${String(n)};\n}`;
}

/**
 * Type-check a snippet against the settings `tsconfig.json` declares.
 *
 * The flags are stated explicitly rather than inherited: naming a file on the
 * command line makes tsc ignore a discovered `tsconfig.json`, and a test that
 * exists to prove one specific setting is doing something is clearer when that
 * setting is visible in the invocation.
 *
 * @param source - TypeScript source to check.
 * @returns Everything tsc printed. Empty when the snippet is clean.
 */
function typecheck(source: string): string {
  // Unique per call for the same reason as `lint` -- concurrent tests sharing
  // one path race each other.
  const target = join(SCRATCH, `typecheck-snippet-${String(nextSnippetId++)}.ts`);
  writeFileSync(target, source, "utf8");

  try {
    execFileSync(
      "bunx",
      [
        "tsc",
        "--noEmit",
        "--strict",
        "--noUncheckedIndexedAccess",
        "--target",
        "es2023",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
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

// Every lint test depends on the other lane's config. `describe.skipIf` makes
// the dependency explicit in the runner output instead of silently passing.
const lintSuite = describe.skipIf(!CONFIG_PRESENT);

if (!CONFIG_PRESENT) {
  console.warn(
    `[enforcement] SKIPPING all lint assertions: ${OXLINT_CONFIG} does not ` +
      "exist yet. It is owned by the .oxlintrc.json lane. These tests are " +
      "meaningless without it -- oxlint would silently fall back to its own " +
      "defaults and a green run would prove nothing about our ceilings.",
  );
}

lintSuite("complexity ceiling fires", () => {
  // Cyclomatic complexity = decision points + 1, so N `if`s score N+1. Size
  // the pile past whatever the ratchet currently allows rather than past the
  // exemplar's 10.
  test("a function past the ceiling is rejected", () => {
    const branches = Array.from(
      { length: requireCeiling("complexity") + 5 },
      (_unused, n) => `  if (value === ${String(n)}) return ${String(n)};`,
    ).join("\n");

    const rules = lint(
      `export function classify(value: number): number {\n${branches}\n  return -1;\n}\n`,
    );

    expectFired(rules, "complexity", "the rule was removed or its max raised");
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

    expect(rules.has("complexity")).toBe(false);
  });
});

lintSuite("max-lines-per-function ceiling fires", () => {
  // SIZE is the third leg -- complexity counts branching and max-depth counts
  // nesting, but a function can pass both while running hundreds of lines. The
  // body here is a flat pile of assignments (complexity 1, depth 0), so only
  // the line ceiling can catch it.
  test("a function past the code-line ceiling is rejected", () => {
    const statements = Array.from(
      { length: requireCeiling("max-lines-per-function") + 10 },
      (_unused, n) => `  const v${String(n)} = ${String(n)};`,
    ).join("\n");

    const rules = lint(
      `export function sprawl(): number {\n${statements}\n  return v0;\n}\n`,
    );

    expectFired(
      rules,
      "max-lines-per-function",
      "the rule was removed, its max raised, or skipComments/skipBlank toggled",
    );
  });

  test("comments and blanks do not count toward the ceiling", () => {
    // skipComments/skipBlankLines are ON because this repo is comment-dense.
    // A short function padded with 60 comment lines must PASS -- if this fails,
    // the limit is counting explanation as code and the whole comment-density
    // teaching is broken.
    const filler = Array.from(
      { length: requireCeiling("max-lines-per-function") + 10 },
      (_unused, n) => `  // note ${String(n)}\n`,
    ).join("\n");

    const rules = lint(
      `export function documented(): number {\n${filler}\n  return 1;\n}\n`,
    );

    expect(rules.has("max-lines-per-function")).toBe(false);
  });
});

lintSuite("max-lines file ceiling fires", () => {
  // One module, one job. The body is 390 lines of tiny single-purpose
  // functions: every per-function rule passes, so only the FILE ceiling can
  // reject it.
  test("a file past the file-line ceiling is rejected", () => {
    const functions = Array.from(
      { length: Math.ceil((requireCeiling("max-lines") + 30) / 3) },
      (_unused, n) =>
        `export function fn${String(n)}(): number {\n  const v = ${String(n)};\n  return v;\n}`,
    ).join("\n");

    const rules = lint(functions);

    expectFired(rules, "max-lines", "the rule was removed or its max raised");
  });

  test("a comment-dense file under the ceiling is accepted", () => {
    // The mirror image, and the one that protects the 30-50% comment rule:
    // comment lines around 30 short functions must PASS. Deliberately UNDER
    // the code ceiling (3 code lines per function, sized to ~half of it) but
    // padded with six comment lines each, so the raw file is far longer than
    // the limit while its CODE is not. If this goes red, skipComments got
    // turned off and the repo now punishes explanation.
    const documented = Array.from(
      { length: Math.floor(requireCeiling("max-lines") / 2 / 3) },
      (_unused, n) => documentedFunction(n),
    ).join("\n\n");

    const rules = lint(documented);

    expect(rules.has("max-lines")).toBe(false);
  });
});

lintSuite("max-params ceiling fires", () => {
  test("a signature past the ceiling is rejected", () => {
    // A long parameter list is a struct nobody named; every caller memorises
    // the order. The sanctioned fix is an options object, checked below.
    const names = Array.from(
      { length: requireCeiling("max-params") + 1 },
      (_unused, n) => `p${String(n)}: number`,
    ).join(", ");

    const rules = lint(`export function wide(${names}): number {\n  return 0;\n}\n`);

    expectFired(rules, "max-params", "the rule was removed or its max raised");
  });

  test("an options object carrying the same fields is accepted", () => {
    // Checked-in fixture: the shape the rule is trying to produce. One named
    // parameter passes at any ceiling, so this one does not need generating.
    const rules = lint(fixture("options-object.ts.txt"));

    expect(rules.has("max-params")).toBe(false);
  });
});

lintSuite("max-depth ceiling fires", () => {
  test("nesting past the ceiling is rejected", () => {
    // Build one more nested `if` than the ratchet allows. Each level is a
    // distinct condition so nothing collapses the block.
    const depth = requireCeiling("max-depth") + 1;
    const open = Array.from(
      { length: depth },
      (_unused, n) => `${"  ".repeat(n + 1)}if (flags[${String(n)}] === true) {`,
    ).join("\n");
    const close = Array.from(
      { length: depth },
      (_unused, n) => `${"  ".repeat(depth - n)}}`,
    ).join("\n");

    const rules = lint(
      `export function deep(flags: boolean[]): number {\n${open}\n${"  ".repeat(depth + 1)}return 1;\n${close}\n  return 0;\n}\n`,
    );

    expectFired(rules, "max-depth", "the rule was removed or its max raised");
  });

  test("guard clauses expressing the same logic are accepted", () => {
    const rules = lint(fixture("guard-clauses.ts.txt"));

    expect(rules.has("max-depth")).toBe(false);
  });
});

lintSuite("no-else-return fires", () => {
  test("else after return is rejected", () => {
    const rules = lint(
      "export function pick(flag: boolean): string {\n" +
        '  if (flag) {\n    return "a";\n  } else {\n    return "b";\n  }\n}\n',
    );

    expectFired(rules, "no-else-return", "the rule was removed");
  });
});

lintSuite("no-empty fires", () => {
  test("a swallowed error is rejected", () => {
    // The single most damaging shape in the set: the failure happened, and
    // nothing above ever learns of it. allowEmptyCatch is off precisely so
    // this cannot be written.
    const rules = lint(fixture("swallowed-catch.ts.txt"));

    expectFired(rules, "no-empty", "allowEmptyCatch was turned back on");
  });
});

lintSuite("typescript rules fire", () => {
  test("an explicit any is rejected", () => {
    const rules = lint("export function take(value: any): void {\n  void value;\n}\n");

    // NOTE the bare name. The config key is `typescript/no-explicit-any`, but
    // the diagnostic marker oxlint prints is `typescript(no-explicit-any)` --
    // plugin OUTSIDE the parentheses, rule name inside. Asserting on the
    // config-style name fails even when the rule has fired correctly.
    expectFired(
      rules,
      "no-explicit-any",
      "the `typescript` plugin was dropped from .oxlintrc.json -- oxlint does " +
        "NOT error on rules whose plugin is absent; they silently stop running",
    );
  });

  test("a non-null assertion is rejected", () => {
    const rules = lint(
      "export function force(values: string[]): string {\n  return values[0]!;\n}\n",
    );

    expectFired(
      rules,
      "no-non-null-assertion",
      "the rule was removed or the `typescript` plugin was dropped",
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

    expect(output).toMatch(/possibly 'undefined'|undefined/);
  });

  test("the guarded form compiles", () => {
    const output = typecheck(
      "export function first(values: string[]): number {\n" +
        "  const head = values[0];\n" +
        "  return head === undefined ? 0 : head.length;\n}\n",
    );

    expect(output.trim()).toBe("");
  });
});

describe("the suite can fail", () => {
  // A guard against the failure mode this whole file exists to prevent: a
  // runner that reports success without evaluating anything.
  test("a false assertion actually throws", () => {
    expect(() => {
      expect(false).toBe(true);
    }).toThrow();
  });
});
