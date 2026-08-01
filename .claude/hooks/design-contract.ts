#!/usr/bin/env bun
/**
 * design-contract -- the soft half of the repo-local design gate.
 *
 * design-lookup-gate.ts blocks unresearched WRITES. It cannot block
 * unresearched TALK: no hook fires between the model deciding to say something
 * and that text reaching the operator. This hook covers that gap the only way
 * it can be covered -- by putting the contract and the design inventory into
 * context on every single prompt, so "I did not know that existed" is never
 * available as an explanation.
 *
 * Kept deliberately short. A long injection gets skimmed, and this repo
 * already carries a large standing policy block.
 */

const CONTRACT = `## Design contract (open-brain, repo-local)

Existing designs in this repo are good and were expensive. The recurring
failure is replacing them with inventions that are worse.

Before proposing ANY structure (schema, stage, pipeline, table, algorithm):
  1. Look it up -- \`aqmd "question"\`, \`aqmd research "question"\`, Open Brain
     recall, or Read the design doc. One command.
  2. State what the existing design says, with file:line.
  3. Propose only the DELTA, and only where measurement shows a break.
  4. If genuinely nothing covers it, write UNVERIFIED and say so plainly.

A structural claim with no citation and no UNVERIFIED tag is a defect.

Design inventory:
  docs/dream-design.md              Light / REM / Deep, triggers, budgets, autonomy
  docs/code-brain-design.md         R3 authority tiers (canon > decided > observed)
  docs/decisions/                   9 decision records extracted from closed issues
  docs/dream-ethereal-runs.md       disposable-output test protocol
  docs/full-send-derivation-spec.md derivation spec
  docs/memory-contract.md           Codex durable-memory protocol
  docs/prior-art/                   gbrain, cognee, graphiti, honcho, mem0, cognee-integrations
  docs/sme/                         review-swarm knowledge base`;

process.stdout.write(CONTRACT);
process.exit(0);
