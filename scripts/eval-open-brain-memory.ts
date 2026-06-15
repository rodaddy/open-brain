#!/usr/bin/env bun
import { formatScorecard, runEvalSuite } from "../eval/open-brain/runner.ts";
import type { EvalFixture } from "../eval/open-brain/types.ts";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of Bun.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const index = Bun.argv.indexOf(`--${name}`);
  const next = index >= 0 ? Bun.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

async function gitCommit(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return code === 0 ? output.trim() : "unknown";
}

async function loadFixture(
  path = "eval/open-brain/fixtures/memory-smoke.json",
): Promise<EvalFixture> {
  try {
    const file = Bun.file(path);
    const fixture = (await file.json()) as EvalFixture;
    if (
      fixture.schema_version !== 1 ||
      !Array.isArray(fixture.corpus) ||
      !Array.isArray(fixture.probes)
    ) {
      throw new Error("expected schema_version=1 with corpus and probes arrays");
    }
    return fixture;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load Open Brain eval fixture ${path}: ${message}`);
  }
}

const reportPath = argValue("report");
const fixturePath = argValue("fixture");
const jsonOnly = Bun.argv.includes("--json");
const commit = await gitCommit();
const fixture = await loadFixture(fixturePath).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
const scorecard = runEvalSuite(fixture, { commit });

if (reportPath) {
  await Bun.write(reportPath, `${JSON.stringify(scorecard, null, 2)}\n`);
}

if (jsonOnly) {
  console.log(JSON.stringify(scorecard, null, 2));
} else {
  console.log(formatScorecard(scorecard));
  if (reportPath) console.log(`\nWrote report: ${reportPath}`);
}

if (scorecard.probes_failed > 0) {
  process.exitCode = 1;
}
