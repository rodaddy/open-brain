# E2E quality gate: scripted input→expected-output runs + Langfuse egress verification

Status: PROPOSED (operator-requested 2026-08-05: "run a whole bunch of actual
tests to verify things instead of me having to literally dogfood everything...
run some inputs and outputs via a script with expected information and also
be able to check what's going out to my Langfuse and see that things are
actually going correctly.")

## What already exists (do not rebuild)

- `eval/open-brain/` — fixture-driven eval harness (#109, closed): runner,
  scorecard, `eval/open-brain/fixtures/*.json`.
- `scripts/eval-open-brain-live.ts` (EVAL-3, #324): live recall gate — seeds a
  unique throwaway namespace, drives the REAL client, scores deterministic
  ranking metrics vs versioned thresholds, tears down its own records,
  exits non-zero on failure, content-free output.
- `scripts/codex-memory-smoke.ts` — smoke path.
- Contract parity suite (`contracts/`) — shape-locks tool payloads.
- Ethereal-run protocol (`docs/dream-ethereal-runs.md`) — disposable-output
  testing for dream stages.

## The delta (two pieces)

1. **Scenario breadth on the existing harness.** New fixtures + runner support
   for the surfaces dogfooding currently covers by hand: capture (hook +
   operator paths — #529's proofs become fixtures), durable_memory pack
   shape/recall correctness, checkpoint/wrap round-trips, session lifecycle.
   Same fixture JSON pattern, same throwaway-namespace + teardown discipline
   as EVAL-3. Each scenario: scripted input, expected output, deterministic
   scoring, non-zero exit on miss.

2. **Langfuse egress verifier (net-new).** After a scenario batch drives real
   traffic with a unique run tag, query the Langfuse instance on CT 273 and
   assert what ACTUALLY arrived: expected trace/observation count for the tag,
   GENERATION rows carry provided_model_name + usage_details + non-NULL cost
   (this IS #560's live receipt, automated), no secret-shaped content in
   trace bodies (automates #561's census as a regression gate), and nothing
   expected went missing (the silent-drop class). Query route: Langfuse public
   API with env-gated keys, fallback documented ClickHouse query. Env-gated
   like the live eval (opt-in, content-free output).

## Why this shape

Reuses the expensive existing designs (fixture runner, live-gate discipline,
parity locks) and adds only the missing egress leg. The verifier closes the
loop the merges keep stopping at: "merged, unverified live" → a command that
produces the live receipt. Feeds the OBS epic (#571): #560 closes via this
tool's first green run; #561's masking gets a permanent regression check.

## Non-goals

Dream-stage quality scoring (owned by ethereal runs), model-answer quality
evals (subjective; this gate is deterministic), CI-required gating on day one
(starts as operator/agent command; CI wiring is a follow-up decision).
