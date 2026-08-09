#!/usr/bin/env bun
/**
 * Driver for the #678 done-means check. Prints one `clause=<id> result=<PASS|FAIL>`
 * line per clause plus a diagnostic line; the shell wrapper reads the lines and
 * owns the verdict. Content-free: key NAMES, counts, and hash PREFIXES only —
 * never a full hash body and never a field description.
 *
 * WHY A DRIVER AND NOT A PLAIN TEST. Two of the five clauses assert facts about
 * the CROSS-LANGUAGE pin (the Python client's literals) and about the parity
 * test's own existence and executability. A bun test can assert the first three;
 * it structurally cannot assert "a test exists that fails when the mirror
 * drifts" without being that test. The driver reads both sides and reports.
 *
 * Every import here is DYNAMIC (round 18: a static import of anything the
 * pre-change tree may not export dies at module resolution before a single
 * clause prints — a false RED indistinguishable in shape from a real one).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Round 12/23: when the subject is this repo's own source, resolve it from the
// script's OWN tree so the check structurally cannot read across worktrees.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

type Verdict = "PASS" | "FAIL";
const results: Array<{ id: string; result: Verdict; why: string }> = [];

function record(id: string, result: Verdict, why: string): void {
  results.push({ id, result, why });
}

function sorted(keys: readonly string[]): string[] {
  return [...keys].sort();
}

function setDiff(a: readonly string[], b: readonly string[]): string[] {
  const bs = new Set(b);
  return sorted(a.filter((k) => !bs.has(k)));
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------
  // Load the three sources of truth.
  // ---------------------------------------------------------------------
  const { TOOL_CONTRACTS } = (await import(
    join(REPO_ROOT, "src", "contract-schemas.ts")
  )) as { TOOL_CONTRACTS: Record<string, { version: number; input_schema: unknown }> };

  const srcTree = (await import(
    join(REPO_ROOT, "src", "tools", "agent-context-pack.ts")
  )) as { agentContextPackInputSchema: Record<string, unknown> };

  const serverTree = (await import(
    join(REPO_ROOT, "server", "tools", "context-pack-args.ts")
  )) as { agentContextPackInputSchema: Record<string, unknown> };

  const contractMod = (await import(join(REPO_ROOT, "src", "contract.ts"))) as {
    buildContract: (generatedAt?: string) => { schema_hash: string; contract_version: string };
    CONTRACT_VERSION: string;
  };

  const mirrorKeys = sorted(
    Object.keys(
      (TOOL_CONTRACTS.agent_context_pack?.input_schema ?? {}) as Record<string, unknown>,
    ),
  );
  const zodSrcKeys = sorted(Object.keys(srcTree.agentContextPackInputSchema));
  const zodServerKeys = sorted(Object.keys(serverTree.agentContextPackInputSchema));

  console.log(`diag mirror_keys=${mirrorKeys.join(",")}`);
  console.log(`diag zod_src_keys=${zodSrcKeys.join(",")}`);
  console.log(`diag zod_server_keys=${zodServerKeys.join(",")}`);

  // ---------------------------------------------------------------------
  // CONTROL clause (round 13: a check that fails everywhere proves only that
  // it fails). agent_reflex_pointers was audited key-by-key this lane and its
  // mirror is ACCURATE pre-change. It must be PASS in the RED run too. If this
  // clause ever goes red alongside the others, the harness is broken, not the
  // mirror.
  // ---------------------------------------------------------------------
  const reflexMirror = sorted(
    Object.keys(
      (TOOL_CONTRACTS.agent_reflex_pointers?.input_schema ?? {}) as Record<string, unknown>,
    ),
  );
  const reflexZod = sorted(
    Object.keys(
      (srcTree as unknown as { agentReflexPointersInputSchema?: Record<string, unknown> })
        .agentReflexPointersInputSchema ??
        (
          (await import(join(REPO_ROOT, "src", "tools", "agent-context-pack.ts"))) as {
            agentReflexPointersInputSchema: Record<string, unknown>;
          }
        ).agentReflexPointersInputSchema,
    ),
  );
  const reflexMissing = setDiff(reflexZod, reflexMirror);
  const reflexExtra = setDiff(reflexMirror, reflexZod);
  record(
    "z-control",
    reflexMissing.length === 0 && reflexExtra.length === 0 ? "PASS" : "FAIL",
    `agent_reflex_pointers mirror parity (expected PASS in BOTH runs) missing=[${reflexMissing.join(",")}] extra=[${reflexExtra.join(",")}]`,
  );

  // ---------------------------------------------------------------------
  // (a) The mirror advertises exactly the keys the live Zod schema accepts.
  //     Both directions: a missing key is an under-advertised contract, an
  //     extra key is a promise the server will REJECT at .strict().
  // ---------------------------------------------------------------------
  const missing = setDiff(zodSrcKeys, mirrorKeys);
  const extra = setDiff(mirrorKeys, zodSrcKeys);
  record(
    "a",
    missing.length === 0 && extra.length === 0 ? "PASS" : "FAIL",
    `agent_context_pack mirror vs live Zod: in_zod_not_in_mirror=[${missing.join(",")}] in_mirror_not_in_zod=[${extra.join(",")}]`,
  );

  // ---------------------------------------------------------------------
  // (b) The two serving trees agree with each other. src/index.ts and
  //     server/main.ts are both reachable (see the duplication note in
  //     agent-context-pack.ts); a mirror reconciled against one tree while the
  //     other has drifted would be accurate and still wrong on the surface
  //     that runs. Independent of (a) on purpose.
  // ---------------------------------------------------------------------
  const treeDiffA = setDiff(zodSrcKeys, zodServerKeys);
  const treeDiffB = setDiff(zodServerKeys, zodSrcKeys);
  record(
    "b",
    treeDiffA.length === 0 && treeDiffB.length === 0 ? "PASS" : "FAIL",
    `src tree vs server tree Zod keys: only_in_src=[${treeDiffA.join(",")}] only_in_server=[${treeDiffB.join(",")}]`,
  );

  // ---------------------------------------------------------------------
  // (c) The drift receipt actually MOVED. This is the clause the issue is
  //     really about: docs/downstream-rollout.md calls schema_hash "the
  //     authoritative drift receipt", and it read the same value before and
  //     after a shape change. The pre-change values are pinned here as
  //     literals, so this clause fails on the pre-change tree BY CONSTRUCTION
  //     and can never be satisfied by a tree that left the mirror alone.
  // ---------------------------------------------------------------------
  const DRIFT_BLIND_VERSION = "2026-07-23.memory-tools.v23";
  const DRIFT_BLIND_HASH_PREFIX = "4b69e9b4";
  const built = contractMod.buildContract("2026-01-01T00:00:00.000Z");
  const hashPrefix = built.schema_hash.slice(0, 8);
  console.log(`diag contract_version=${built.contract_version} schema_hash_prefix=${hashPrefix}`);
  const versionMoved = built.contract_version !== DRIFT_BLIND_VERSION;
  const hashMoved = hashPrefix !== DRIFT_BLIND_HASH_PREFIX;
  record(
    "c",
    versionMoved && hashMoved ? "PASS" : "FAIL",
    `receipt moved off the drift-blind values: version_moved=${versionMoved} hash_moved=${hashMoved} (blind version=${DRIFT_BLIND_VERSION} blind hash prefix=${DRIFT_BLIND_HASH_PREFIX})`,
  );

  // ---------------------------------------------------------------------
  // (d) The Python client is pinned to what the server actually serves.
  //     Read from the SOURCE LITERALS, not by importing Python: the pin is a
  //     cross-language constant and a mismatch is exactly what
  //     _runtime_router.py rejects at runtime. A stale pin here means every
  //     downstream compat check fails closed the moment the server deploys.
  // ---------------------------------------------------------------------
  const clientPath = join(
    REPO_ROOT,
    "python",
    "openbrain-memory",
    "src",
    "openbrain_memory",
    "client.py",
  );
  const clientSrc = readFileSync(clientPath, "utf8");
  const pinnedVersion = /CURRENT_CONTRACT_VERSION\s*=\s*"([^"]+)"/.exec(clientSrc)?.[1];
  // The hash literal is written across continuation lines; join the quoted parts.
  const hashBlock = /CURRENT_CONTRACT_SCHEMA_HASH\s*=\s*\(([\s\S]*?)\)/.exec(clientSrc)?.[1];
  const pinnedHash = hashBlock
    ? [...hashBlock.matchAll(/"([0-9a-f]*)"/g)].map((m) => m[1]).join("")
    : /CURRENT_CONTRACT_SCHEMA_HASH\s*=\s*"([0-9a-f]+)"/.exec(clientSrc)?.[1];
  const pinVersionOk = pinnedVersion === built.contract_version;
  const pinHashOk = pinnedHash === built.schema_hash;
  console.log(
    `diag python_pin_version=${pinnedVersion ?? "<unparsed>"} python_pin_hash_prefix=${(pinnedHash ?? "<unparsed>").slice(0, 8)}`,
  );
  record(
    "d",
    pinVersionOk && pinHashOk ? "PASS" : "FAIL",
    `python client pin matches the served contract: version_ok=${pinVersionOk} hash_ok=${pinHashOk}`,
  );

  // ---------------------------------------------------------------------
  // (e) THE ANTI-RECURRENCE CLAUSE, and the one that makes this check about
  //     the DEFECT CLASS rather than about three key names. A committed,
  //     executable test must assert mirror-vs-Zod key parity — otherwise (a)
  //     is a one-time reconciliation and the next shape change is silent
  //     again, which is the entire content of #678.
  //
  //     Existence of a file is not the claim; the claim is that the assertion
  //     DISCRIMINATES. The shell wrapper proves that separately by mutating
  //     the mirror and requiring the test to fail (round 25: prove the
  //     prover). Here we assert only that the test file exists, is committed,
  //     and names both sides of the comparison.
  // ---------------------------------------------------------------------
  const parityTest = join(REPO_ROOT, "src", "contract-schema-parity.test.ts");
  const parityExists = existsSync(parityTest);
  const parityBody = parityExists ? readFileSync(parityTest, "utf8") : "";
  const namesMirror = parityBody.includes("contract-schemas");
  const namesSrcZod = parityBody.includes("tools/agent-context-pack");
  const namesServerZod = parityBody.includes("tools/context-pack-args");
  record(
    "e",
    parityExists && namesMirror && namesSrcZod && namesServerZod ? "PASS" : "FAIL",
    `anti-recurrence test present and reads all three sources: exists=${parityExists} names_mirror=${namesMirror} names_src_zod=${namesSrcZod} names_server_zod=${namesServerZod}`,
  );

  // ---------------------------------------------------------------------
  for (const r of results) {
    console.log(`clause=${r.id} result=${r.result} why=${r.why}`);
  }
}

// Round 13: a top-level `await main()` with no `.catch` EXITS 0 when it throws,
// which banks a false GREEN the shell wrapper cannot detect. Catch and exit 1.
main().catch((error: unknown) => {
  console.log(
    `clause=driver result=FAIL why=driver threw: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
