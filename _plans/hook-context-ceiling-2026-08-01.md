# Hook additionalContext inline bound — measurement + fit check (2026-08-01)

Status: WRITTEN (measured this session against Claude Code 2.1.220 and the live
dogfood Open Brain). Not merged. The operator picks the option; this doc records
facts and projected outcomes only.

Issue: #450. Related: canon render lands whole as plain text
(`python/openbrain/src/openbrain/apps/hooks/session_start.py`, commit e6d1f1e).

Every number below is labelled **measured**, **doc-stated**, or **inferred**.

## The question

`openbrain-session-start` emits the 31-rule canon pack as plain-text
`additionalContext` on `SessionStart`. Claude Code ~2.1.220 diverts a large
`additionalContext` string to a persisted file and hands the model only a
preview, so a cold session sees the header + first few rules instead of all 31.
This measures exactly where that divert happens and whether the whole 31-rule
pack can be delivered inline.

## 1. What the official docs state (doc-stated)

Source: `https://code.claude.com/docs/en/hooks` (fetched 2026-08-01), corroborated
by a second independent summary of the same page.

- **Bound = 10,000 characters.** "Hook output strings, including
  `additionalContext`, `systemMessage`, and plain stdout, are capped at 10,000
  characters. Output that exceeds this limit is saved to a file and replaced with
  a preview and file path, the same way large tool results are handled."
- **Unit = characters, not bytes.** The docs state the number in characters.
- **Divert behavior:** "If a value exceeds 10,000 characters, Claude Code writes
  the full text to a file in the session directory and passes Claude the file
  path with a short preview instead."
- **Per-event differences:** none stated. The docs apply the same 10,000-char
  rule uniformly to every event that supports `additionalContext`
  (`SessionStart`, `UserPromptSubmit`, `SessionStart` source=compact, etc.).
- **Knob to raise it:** NONE. No setting, config option, or environment variable
  in the docs raises or controls the 10,000-character bound.
- Related changelog note (doc-stated): a fix for `PreToolUse` hook
  `additionalContext` being dropped on tool failure. Nothing about changing the
  10,000-char bound. The dedicated release-notes page 404s at
  `code.claude.com/docs/en/release-notes`; the number lives in the hooks
  reference itself.

## 2. Empirical bisection (measured)

Method: a disposable fixed-`--session-id` `claude -p` run (cheapest model,
`claude-haiku-4-5-20251001`; hooks fire regardless of model) in an isolated
scratch project — the real repo's `.claude/settings.json` was never touched.
A scratch `SessionStart` hook emitted EXACTLY N characters of numbered plain
text with a unique BEGIN token at the head and a unique END token at the tail.

Ground truth is NOT the model's self-report (haiku was unreliable at echoing the
tokens). It is the session transcript's `attachment` record: `.attachment.content[0]`
is byte-exact what the harness placed into the model's context for the hook.
- **INLINED** = `content[0]` contains the END token (whole payload delivered).
- **DIVERTED** = `content[0]` is the preview wrapper, END token absent.

Scratch + method + probe scripts:
`{temp_workspace}/open-brain/_validation-runs/hc-probe/` (probe.sh, emit.py,
verdict.py, fitcheck.py).

| N (chars) | verdict | content[0] length |
|-----------|---------|-------------------|
| 500       | INLINED | 500 |
| 9,999     | INLINED | 9,999 |
| **10,000**| **INLINED** | 10,000 |
| **10,001**| **DIVERTED** | 2,279 (preview) |
| 10,240    | DIVERTED | 2,277 |
| 11,000    | DIVERTED | 2,280 |
| 30,000    | DIVERTED | 2,280 |

**Measured boundary: 10,000 characters is the last INLINED length; 10,001 is the
first DIVERTED length.** Repeated once at the boundary — identical result, stable.

This exactly matches the doc-stated 10,000-character bound, and the bound is
inclusive (10,000 still inlines). The payloads were pure ASCII so bytes == chars
in this probe; the divert decision is on the 10,000-**character** string length.
(The divert wrapper's own "Output too large (9.8KB)" label reports the persisted
file's BYTE size, which is why the label reads KB — that is a display of the file,
not the divert trigger.)

### Preview size and shape (measured)

When diverted, the model receives (~2,277–2,325 chars total) a wrapper of the form:

```
<persisted-output>
Output too large (9.8KB). Full output saved to: <session-dir>/tool-results/hook-<uuid>-additionalContext.txt

Preview (first 2KB):
<the first ~2KB of the additionalContext string>
...
</persisted-output>
```

The visible slice of the payload is the **first 2KB** (~2,048 chars) of the
emitted text; the rest is only on disk. For the canon pack that is the header
plus roughly the first 5–6 rules — which is exactly the cold-session symptom
reported on #450.

## 3. Fit check (measured against live canon)

Live canon fetched with the SAME `agent_context_pack` client call and rendered
with the SAME `render_pack` the hook uses.

- **Current rendered canon: 12,253 bytes / 12,253 chars, 31 items** (pure ASCII).
  (The #450 figure of 12,254 is stale by one byte; negligible.)
- Header line: 123 chars.
- Rendering scaffolding (per-item `[lane] <key>: ` prefixes): 1,263 chars total.
- Newlines (header + blank + one per item): 32 chars.
- **Pure rule text alone (guidance/fact strings, no prefixes, no header,
  no newlines): 10,835 chars.**
- Per-rule sizes (chars, ascending): min 171, median 318, mean 349.5, max 645.
  Sections: profile_guidance=10, process_guidance=14, repo_facts=7.

### (a) Measured boundary
10,000 characters (matches doc-stated).

### (b) Does removing ONLY rendering scaffolding fit 31 whole rules under 10,000?
**No.** Projected size with every prefix, the header, and all-but-joining
newlines removed — rule text 100% intact, joined by one newline per item —
is **10,865 chars** (10,835 rule text + 30 joining newlines). That is still
**865 chars OVER** the 10,000 boundary.

The reason is decisive: **the pure rule text by itself (10,835 chars) already
exceeds 10,000.** The scaffolding (~1,418 chars of prefixes+header+newlines) is
not what pushes it over — the rules alone do. No amount of overhead removal, with
zero rule-text change, delivers all 31 whole rules inline.

### (c) Pure rule-text total, for the operator's option-1 sizing
**10,835 characters of rule text across 31 rules.** To land all 31 whole rules
inline under the 10,000-char boundary WITHOUT any structural knob, the rule text
itself would need to come down by at least **835 characters** (10,835 → ≤10,000),
before re-adding any joining newlines — realistically ~865+ once one newline per
rule is counted. That is rule-text editing, not overhead removal. This doc does
not propose doing it; it reports the exact gap so the operator can decide.

### (d) Does any doc-sanctioned knob make this moot?
**No.** The docs expose no setting or environment variable that raises the
10,000-character bound. There is no sanctioned way to land a >10,000-char
`additionalContext` string inline in a single hook emission.

## 4. Options (operator decides — not chosen here)

All three keep every rule's TEXT whole unless option 1 is explicitly taken.

**Option 1 — reduce rule text to fit one emission.**
Bring the 10,835 chars of rule text down by ~865+ chars so header + prefixes +
rules land ≤10,000 inline. Projected: all 31 rules inline in one SessionStart
emission. Cost: rule text is edited (the operator's call on which rules and by
how much); the boundary is real and this is the only single-emission path.

**Option 2 — deliver the pack across more than one inline-sized emission.**
`SessionStart` supports multiple hook commands, and each hook's `additionalContext`
is diverted independently. Two emissions of ≤10,000 chars each land BOTH inline
(31 rules ≈ two ~6,100-char halves). Projected: all 31 rules inline, zero
rule-text change, split across 2 hook outputs. Cost: the pack is presented as two
context blocks instead of one; needs the emitter to partition deterministically.
(Inferred from the per-hook, per-string divert behavior measured above; each of
two ≤10,000 emissions would inline by the same rule — worth a confirming probe
before adopting.)

**Option 3 — accept the persisted-file + preview, make the file first-class.**
Let the >10,000 payload divert as-is, but ensure the preview's first 2KB carries
a pointer/instruction the session acts on to read the full persisted file. The
harness already writes the whole pack to disk; this treats that as the delivery
mechanism instead of fighting it. Projected: all 31 rules on disk, reliably
reachable; the model sees header + ~first 5–6 rules inline plus a read
instruction. Cost: not "front-of-mind whole" the way inline is — depends on the
session actually opening the file.

## Provenance / how to reproduce

- Harness: Claude Code 2.1.220.
- Docs: `https://code.claude.com/docs/en/hooks` (2026-08-01).
- Probe scripts + transcripts: `{temp_workspace}/open-brain/_validation-runs/hc-probe/`.
- Canon fetch/render: `fitcheck.py` in that dir — same client + `render_pack` as
  `python/openbrain/src/openbrain/apps/hooks/session_start.py`.
- Fixtures capture method this builds on:
  `python/openbrain/tests/fixtures/captured_hooks/README.md`.
