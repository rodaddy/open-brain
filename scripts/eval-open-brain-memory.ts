#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatScorecard, runEvalSuite } from "../eval/open-brain/runner.ts";
import type { EvalFixture } from "../eval/open-brain/types.ts";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

async function gitCommit(): Promise<string> {
  // execFileSync rather than a hand-rolled promise wrapper: a bounded one-line
  // capture needs no async plumbing. Unlike the other two eval scripts this
  // one had NO try/catch and relied on the exit code to yield "unknown", so
  // the catch here is load-bearing: execFileSync throws on a non-zero exit,
  // and dropping it would turn a missing-git run into a crash.
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

async function loadFixture(
  path = "eval/open-brain/fixtures/memory-smoke.json",
): Promise<EvalFixture> {
  try {
    const fixture = JSON.parse(await readFile(path, "utf8")) as EvalFixture;
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
const jsonOnly = process.argv.includes("--json");
const commit = await gitCommit();
const fixture = await loadFixture(fixturePath).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
const scorecard = runEvalSuite(fixture, { commit });

if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(scorecard, null, 2)}\n`);
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
