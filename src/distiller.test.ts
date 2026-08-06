/**
 * Functional tests for the DISTILL extractor (#382).
 *
 * THE CONTRACT UNDER TEST is the 2026-07-28 governing decision: let everything
 * pass. Nothing is pre-filtered on a guess. The extractor may record doubt
 * (`uncertain` + a reason) but it may never drop content because the content is
 * short, odd, or looks unimportant -- src/dream-light.ts:159-190 records the
 * measured reason, and 037_candidate_memory_uncertainty.sql:1-30 encodes it.
 *
 * So the shape of this file is deliberately asymmetric, mirroring
 * src/dream-light.test.ts: it is STRICT about what must survive and permissive
 * about classification. A wrong `candidate_type` is a label the operator fixes
 * on the grading page; a dropped turn is invisible and unrecoverable.
 *
 * The two documented drops are asserted as drops, by shape and not by size:
 * harness scaffolding (src/tools/ingest-raw-turn.ts:55-64) and a tool-call stub
 * whose payload was discarded upstream. Rejecting an EMPTY string is not the
 * same act as rejecting a SHORT one, and these tests exist to keep that
 * distinction from eroding.
 */

import { describe, expect, it } from "bun:test";
import {
  CANDIDATE_TYPES,
  CANDIDATE_PART_CHARS,
  RULE_BASED_DISTILLER_NAME,
  ruleBasedDistiller,
  runDistillUnit,
  type DistillCandidate,
  type NamedDistillModel,
} from "./distiller.ts";
import { contentHash } from "./embedding.ts";
import {
  BackgroundTraceRecorder,
  type BackgroundTraceBody,
  type BackgroundTraceEmitter,
} from "./background-tracing.ts";
import type { DistillTurn, DistillUnit } from "./distill-window.ts";

let n = 0;

function recordingTracing(): BackgroundTraceEmitter & {
  bodies: BackgroundTraceBody[];
} {
  const bodies: BackgroundTraceBody[] = [];
  return {
    bodies,
    emitBackground(body) {
      bodies.push(body);
    },
  };
}

function turn(over: Partial<DistillTurn> = {}): DistillTurn {
  n++;
  return {
    id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
    namespace: "rico",
    session_ref: "s1",
    session_seq: n,
    role: "user",
    content: "content",
    repo: "open-brain",
    occurred_at: new Date(Date.UTC(2026, 6, 28, 0, n)),
    is_human_prompt: true,
    ...over,
  };
}

/** Extract from one turn with an optional read-only context window. */
async function extract(
  content: string,
  opts: { role?: string; context?: DistillTurn[] } = {},
): Promise<DistillCandidate[]> {
  const current = turn({ content, role: opts.role ?? "user" });
  const res = await ruleBasedDistiller.extract({
    current,
    context: opts.context ?? [],
  });
  return res.candidates;
}

describe("nothing is suppressed — every turn shape yields a candidate", () => {
  // Each entry is a real corpus shape or a deliberate pathology. Every one of
  // them must produce a candidate: there is no length floor, no salience score,
  // and no "probably not worth it" branch anywhere in the extractor.
  const mustSurvive: Array<[label: string, content: string, role?: string]> = [
    ["a single character", "y"],
    ["a two-character authorization", "go"],
    ["the shortest real operator turns", "go for it"],
    ["a bare punctuation mark", "."],
    ["emoji only", "🚀🚀🚀"],
    ["a lone question mark", "?"],
    ["mixed punctuation", "?!?!"],
    ["a bare number", "42"],
    ["a URL and nothing else", "https://example.invalid/x"],
    ["a file path", "src/dream-light.ts:159"],
    ["a code fence", "```ts\nconst x = 1;\n```"],
    ["a huge JSON blob", `{"rows":[${'{"a":1},'.repeat(500)}{"a":1}]}`],
    ["a 10k-character wall of prose", "the delta is five rows. ".repeat(420)],
    ["an assistant result", "2370 pass, 0 fail", "assistant"],
    ["assistant narration", "Let me get them properly.", "assistant"],
    ["an unknown role's speech", "we are going with pgvector", "sysop"],
    ["leading/trailing whitespace only around one word", "   ok   "],
    ["a tab-and-newline soup with content", "\t\n  switched both \n\n"],
  ];

  for (const [label, content, role] of mustSurvive) {
    it(`keeps ${label}`, async () => {
      const candidates = await extract(content, role ? { role } : {});
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.content.length).toBeGreaterThan(0);
      expect(CANDIDATE_TYPES).toContain(candidates[0]!.candidate_type);
    });
  }

  it("stores a 10,000-character turn WHOLE", async () => {
    // This test previously asserted the opposite: that the candidate was cut to
    // ~4,000 and carried a "truncated" marker. The stated reason was that
    // src/embedding.ts refused input over 32,000 characters. It no longer does
    // -- long text is embedded in overlapping segments -- so there is nothing
    // left for the cut to protect, and the operator's words are kept.
    const long = "x".repeat(10_000);
    const [candidate] = await extract(long);
    expect(candidate).toBeDefined();
    expect(candidate!.content).toHaveLength(10_000);
    expect(candidate!.content).not.toContain("truncated");
  });

  it("stores a turn far larger than one rendered part WHOLE", async () => {
    // 51,283 is the longest turn actually captured in the live dogfood clone
    // (open_brain_local_20260724, ob_raw_turns, measured 2026-07-30).
    const huge = "z".repeat(51_283);
    const [candidate] = await extract(huge);
    expect(candidate!.content).toHaveLength(51_283);
    expect(candidate!.content).not.toContain("truncated");
  });
});

describe("the only two drops are documented non-speech shapes", () => {
  it("drops a tool-call stub, whose payload was discarded upstream", async () => {
    // 61% of assistant turns are these (distiller.ts:117-130). They are real
    // corpus rows and useful as window context, but "[tool_use: Bash]" is not a
    // claim about anything.
    for (const stub of [
      "[tool_use: Bash]",
      "[tool_use: Read]",
      "[tool_result]",
      "[image]",
    ]) {
      expect(await extract(stub, { role: "assistant" })).toEqual([]);
    }
  });

  it("drops harness scaffolding, which ingest should never have stored", async () => {
    expect(await extract("[Request interrupted by user]")).toEqual([]);
    expect(await extract("Continue from where you left off.")).toEqual([]);
  });

  it("drops only genuinely EMPTY content, never merely short content", async () => {
    // The distinction the whole governing decision rests on.
    expect(await extract("")).toEqual([]);
    expect(await extract("     ")).toEqual([]);
    expect(await extract("\n\n\t")).toEqual([]);
    // One character survives.
    expect(await extract("k")).toHaveLength(1);
  });

  it("keeps text that merely MENTIONS a stub rather than being one", async () => {
    // The stub patterns are anchored, so a turn discussing tool calls is speech.
    const [c] = await extract(
      "the [tool_use: Bash] stubs are 61% of assistant turns",
    );
    expect(c).toBeDefined();
  });
});

describe("a short turn carries its proposal, not the literal word", () => {
  it("folds the preceding proposal into an acknowledgement candidate", async () => {
    // THE CENTRAL CASE (#382). Without this a stored candidate reading "go for
    // it" is unreviewable -- there is nothing in it to grade.
    const proposal = turn({
      role: "assistant",
      content: "I can switch both capture hooks to the new host.",
    });
    const [candidate] = await extract("go for it", { context: [proposal] });

    expect(candidate!.content).toContain(
      "I can switch both capture hooks to the new host.",
    );
    expect(candidate!.candidate_type).toBe("decision");
    // Flagged, because assent and doubt are the same string -- only the
    // reviewer can tell which (dream-light.ts:161-176).
    expect(candidate!.uncertain).toBe(true);
    expect(candidate!.uncertainty_reason).toBeTruthy();
  });

  it("reaches past a tool turn to the nearest SPEECH turn for the proposal", async () => {
    const proposal = turn({
      role: "assistant",
      content: "Migration 040 would add the trigger.",
    });
    const toolNoise = turn({ role: "tool", content: "(Bash: no output)" });
    const [candidate] = await extract("do it", {
      context: [proposal, toolNoise],
    });
    expect(candidate!.content).toContain(
      "Migration 040 would add the trigger.",
    );
    expect(candidate!.content).not.toContain("(Bash: no output)");
  });

  it("skips a tool-call stub when looking for the proposal", async () => {
    const proposal = turn({ role: "assistant", content: "Use halfvec(768)." });
    const stub = turn({ role: "assistant", content: "[tool_use: Edit]" });
    const [candidate] = await extract("yes", { context: [proposal, stub] });
    expect(candidate!.content).toContain("Use halfvec(768).");
    expect(candidate!.content).not.toContain("[tool_use: Edit]");
  });

  it("still emits an ack with NO context, and says why it is unreadable", async () => {
    // Emitted regardless -- the governing decision permits recording doubt, not
    // acting on it.
    const [candidate] = await extract("go", { context: [] });
    expect(candidate).toBeDefined();
    expect(candidate!.uncertain).toBe(true);
    expect(candidate!.uncertainty_reason).toContain("no preceding speech turn");
  });

  it("bounds the folded proposal so the candidate stays a claim, not a transcript", async () => {
    const huge = turn({ role: "assistant", content: "z".repeat(5_000) });
    const [candidate] = await extract("ok", { context: [huge] });
    expect(candidate!.content.length).toBeLessThan(1_000);
  });
});

describe("classification is generous and records its doubt", () => {
  it("labels an explicit preference narrowly", async () => {
    // `preference` was the 2026-07-24 run's failure mode: 112 of 214 mislabels
    // (dream-design.md:230-239). A wide rule reproduces exactly that.
    expect((await extract("I prefer bun over node"))[0]!.candidate_type).toBe(
      "preference",
    );
    // An OAuth redirect URI is NOT a preference -- that was a real mislabel.
    expect(
      (await extract("the redirect uri is https://x.invalid/callback"))[0]!
        .candidate_type,
    ).not.toBe("preference");
  });

  it("labels a correction as a correction, flagged", async () => {
    const [c] = await extract("no, that's not what I said");
    expect(c!.candidate_type).toBe("correction");
    expect(c!.uncertain).toBe(true);
  });

  it("labels a directive as a decision without flagging it", async () => {
    const [c] = await extract("from now on use session_seq for ordering");
    expect(c!.candidate_type).toBe("decision");
    expect(c!.uncertain).toBe(false);
  });

  it("defaults an unmarked operator turn to decision, flagged and kept", async () => {
    const [c] = await extract("the box has 64 gigs");
    expect(c!.candidate_type).toBe("decision");
    expect(c!.uncertain).toBe(true);
    expect(c!.uncertainty_reason).toContain("no decision");
  });

  it("defaults assistant speech to fact -- the assistant reports, it does not decide", async () => {
    const [c] = await extract("2370 pass, 0 fail", { role: "assistant" });
    expect(c!.candidate_type).toBe("fact");
    expect(c!.uncertain).toBe(false);
  });

  it("flags assistant narration as intent rather than outcome", async () => {
    const [c] = await extract("Let me check the migration order.", {
      role: "assistant",
    });
    expect(c!.candidate_type).toBe("fact");
    expect(c!.uncertain).toBe(true);
    expect(c!.uncertainty_reason).toContain("narration");
  });

  it("every uncertain candidate carries a reason a reviewer can act on", async () => {
    // A flag with no reason is noise on the grading page.
    for (const text of ["go", "no, revert that", "the box has 64 gigs"]) {
      const [c] = await extract(text);
      if (c!.uncertain) {
        expect(c!.uncertainty_reason).toBeTruthy();
        expect(c!.uncertainty_reason!.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("runDistillUnit — provenance and write guards", () => {
  function unit(over: Partial<DistillTurn> = {}): DistillUnit {
    return {
      current: turn({ content: "we are going with pgvector", ...over }),
      context: [turn({ role: "assistant", content: "earlier context" })],
    };
  }

  it("attributes a candidate to the CURRENT turn only", async () => {
    const u = unit();
    const [prepared] = await runDistillUnit(ruleBasedDistiller, u);
    expect(prepared!.source_turn_ids).toEqual([u.current.id]);
    for (const ctx of u.context) {
      expect(prepared!.source_turn_ids).not.toContain(ctx.id);
    }
  });

  it("REPLACES a model's attribution of context turns instead of trusting it", async () => {
    // A model quietly attributing context turns corrupts provenance in a way
    // that is invisible until someone audits a candidate months later
    // (distiller.ts:97-103). Replaced rather than rejected: dropping the
    // candidate would lose real content over a provenance error.
    const u = unit();
    const liar: NamedDistillModel = {
      name: "liar/v1",
      extract: async (req) => ({
        candidates: [
          {
            candidate_type: "fact",
            content: "claims everything nearby",
            source_turn_ids: [
              ...req.context.map((t) => t.id),
              "33333333-3333-4333-8333-333333333333",
            ],
            uncertain: false,
          },
        ],
      }),
    };
    const [prepared] = await runDistillUnit(liar, u);
    expect(prepared!.source_turn_ids).toEqual([u.current.id]);
  });

  it("coerces an out-of-vocabulary type instead of dropping the content", async () => {
    // An unknown candidate_type would violate candidate_memory_type_check.
    const rogue: NamedDistillModel = {
      name: "rogue/v1",
      extract: async () => ({
        candidates: [
          {
            candidate_type: "insight" as never,
            content: "real content with a bogus label",
            source_turn_ids: [],
            uncertain: false,
          },
        ],
      }),
    };
    const [prepared] = await runDistillUnit(rogue, unit({ role: "user" }));
    expect(prepared!.content).toBe("real content with a bogus label");
    expect(CANDIDATE_TYPES).toContain(prepared!.candidate_type);
    expect(prepared!.candidate_type).toBe("decision");
  });

  it("drops only empty content, because there is nothing to keep", async () => {
    const empty: NamedDistillModel = {
      name: "empty/v1",
      extract: async () => ({
        candidates: [
          {
            candidate_type: "fact",
            content: "   \n  ",
            source_turn_ids: [],
            uncertain: false,
          },
        ],
      }),
    };
    expect(await runDistillUnit(empty, unit())).toEqual([]);
  });

  it("hashes with the SAME function ingest applies to turns", async () => {
    // This is what makes a candidate hash and a turn hash directly comparable,
    // which is the whole basis of the content_occurrences join in REM and Deep.
    const [prepared] = await runDistillUnit(ruleBasedDistiller, unit());
    expect(prepared!.content_hash).toBe(contentHash(prepared!.content));
  });

  it("stamps the producing model so two extractors stay comparable", async () => {
    const [prepared] = await runDistillUnit(ruleBasedDistiller, unit());
    expect(prepared!.model).toBe(RULE_BASED_DISTILLER_NAME);
  });

  it("carries the current turn's namespace, never a default", async () => {
    const u: DistillUnit = {
      current: turn({ namespace: "shared-kb", content: "use shared-kb" }),
      context: [],
    };
    const [prepared] = await runDistillUnit(ruleBasedDistiller, u);
    expect(prepared!.namespace).toBe("shared-kb");
  });

  it("NEVER produces a review or grading field — the operator queue is untouchable", async () => {
    // 037:43-57. A producer that emitted review_action would set reviewed_at by
    // constraint and silently remove the item from human review. The prepared
    // shape is the last chance to catch it before the INSERT.
    const u = unit();
    const [prepared] = await runDistillUnit(ruleBasedDistiller, u);
    const keys = Object.keys(prepared!);
    for (const forbidden of [
      "review_action",
      "reviewed_at",
      "graded_by",
      "machine_grade",
      "machine_grade_model",
      "authority_tier",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("a model that tries to smuggle review fields cannot get them through", async () => {
    const smuggler: NamedDistillModel = {
      name: "smuggler/v1",
      extract: async () => ({
        candidates: [
          {
            candidate_type: "fact",
            content: "graded by the machine",
            source_turn_ids: [],
            uncertain: false,
            review_action: "promoted",
            reviewed_at: new Date().toISOString(),
            graded_by: "rico",
            machine_grade: "promoted",
          } as unknown as DistillCandidate,
        ],
      }),
    };
    const [prepared] = await runDistillUnit(smuggler, unit());
    const keys = Object.keys(prepared!);
    expect(keys).not.toContain("review_action");
    expect(keys).not.toContain("reviewed_at");
    expect(keys).not.toContain("graded_by");
    expect(keys).not.toContain("machine_grade");
  });

  it("emits an LLM extractor as a generation with model usage", async () => {
    const emitter = recordingTracing();
    const trace = new BackgroundTraceRecorder(emitter, {
      name: "memory.distill",
      tags: ["background-job", "dream"],
    });
    const model: NamedDistillModel = {
      name: "fixture-distiller",
      observationType: "generation",
      extract: async (request) => ({
        candidates: [
          {
            candidate_type: "fact",
            content: "provider-backed candidate",
            source_turn_ids: [request.current.id],
            uncertain: false,
          },
        ],
        usageDetails: { input: 11, output: 4 },
      }),
    };

    const prepared = await runDistillUnit(model, unit(), trace);
    trace.finish({ candidates: prepared.length });

    expect(emitter.bodies[0]).toMatchObject({
      observations: [
        {
          name: "distill.extract",
          type: "generation",
          model: "fixture-distiller",
          usageDetails: { input: 11, output: 4 },
        },
      ],
    });
  });
});
