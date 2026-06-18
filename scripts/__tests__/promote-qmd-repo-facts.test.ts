import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { promoteManifest } from "../promote-qmd-repo-facts.ts";

const fact = {
  source_system: "qmd" as const,
  repo: "king-core",
  collection: "king",
  path: "src/types/api.ts",
  symbol: "ApiResponse",
  fact_type: "api_contract" as const,
  fact: "Use ApiResponse<T> from @king-capital/core/types; do not hand-roll response envelopes.",
  source_commit: "a85bf4ff1662c56147cafbe31f2feeeb97c0dce6",
  source_url:
    "https://github.com/King-Capital/king-core/blob/a85bf4ff1662c56147cafbe31f2feeeb97c0dce6/src/types/api.ts",
  verified_at: "2026-06-18T08:00:00.000Z",
  confidence: 1,
  staleness_policy: "stable_fact_verify_source" as const,
  refresh_hint: "Verify source before editing response contracts.",
};

describe("promoteManifest", () => {
  function manifest(facts = [fact]) {
    return {
      version: 1 as const,
      source: {
        system: "qmd" as const,
        collection: "king",
        exported_at: "2026-06-18T08:00:00.000Z",
      },
      defaults: { namespace: "collab" },
      facts,
    };
  }

  function fakeMcp2Cli(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ob-qmd-promotion-test-"));
    const file = join(dir, "mcp2cli");
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    return file;
  }

  it("dry-runs valid curated repo facts without calling mcp2cli", () => {
    const summary = promoteManifest(
      manifest(),
      { dryRun: true, mcp2cli: "does-not-exist" },
    );

    expect(summary).toMatchObject({
      total: 1,
      would_promote: 1,
      promoted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      dry_run: true,
    });
  });

  it("skips duplicate fact identities inside one manifest", () => {
    const summary = promoteManifest(
      manifest([fact, fact]),
      { dryRun: true },
    );

    expect(summary.would_promote).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("fails conflicting duplicate fact identities inside one manifest", () => {
    const changed = {
      ...fact,
      fact: "Changed fact text with same identity.",
    };

    const summary = promoteManifest(manifest([fact, changed]), { dryRun: true });

    expect(summary.would_promote).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]?.error).toContain("Conflicting duplicate");
  });

  it("reports exact existing facts as unchanged without upserting", () => {
    const mcp = fakeMcp2Cli(`#!/usr/bin/env bun
const tool = process.argv[3];
if (tool === "list_repo_facts") {
  console.log(JSON.stringify({success:true,result:[{metadata:${JSON.stringify(fact)}}]}));
  process.exit(0);
}
console.error("upsert should not be called");
process.exit(9);
`);

    const summary = promoteManifest(manifest(), { mcp2cli: mcp });

    expect(summary.unchanged).toBe(1);
    expect(summary.promoted).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it("reports stale existing facts as updated after an upsert", () => {
    const stale = { ...fact, source_commit: "1111111" };
    const mcp = fakeMcp2Cli(`#!/usr/bin/env bun
const tool = process.argv[3];
if (tool === "list_repo_facts") {
  console.log(JSON.stringify({success:true,result:[{metadata:${JSON.stringify(stale)}}]}));
  process.exit(0);
}
if (tool === "upsert_repo_fact") {
  console.log(JSON.stringify({success:true,result:{is_new:false}}));
  process.exit(0);
}
process.exit(8);
`);

    const summary = promoteManifest(manifest(), { mcp2cli: mcp });

    expect(summary.stale).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.unchanged).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it("reports mcp2cli upsert failures", () => {
    const mcp = fakeMcp2Cli(`#!/usr/bin/env bun
const tool = process.argv[3];
if (tool === "list_repo_facts") {
  console.log(JSON.stringify({success:true,result:[]}));
  process.exit(0);
}
if (tool === "upsert_repo_fact") {
  console.log(JSON.stringify({success:false,error:{message:"boom"}}));
  process.exit(0);
}
process.exit(8);
`);

    const summary = promoteManifest(manifest(), { mcp2cli: mcp });

    expect(summary.failed).toBe(1);
    expect(summary.failures[0]?.error).toContain("boom");
  });
});
