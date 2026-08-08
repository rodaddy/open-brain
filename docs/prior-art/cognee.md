# Cognee — prior art review

**Reviewed:** 2026-07-27
**Reviewer note:** every claim below is cited to a file and line in the clone.
Nothing here comes from a README, a blog post, or marketing.

## Provenance

| | |
|---|---|
| Upstream | `github.com/topoteretes/cognee` and `github.com/topoteretes/cognee-integrations` |
| Clone commit | cognee `90b4aca` (2026-07-21), cognee-integrations `6b13330` (2026-07-24) |
| Local path | `/path/to/open-brain/open-brain-local/research/` |
| License | cognee **Apache-2.0**; cognee-integrations ships **no LICENSE file** |
| Code reuse | **No.** We take ideas only. cognee-integrations is unlicensed, so its files could not be copied even if we wanted to. |

All paths below are relative to
`cognee-integrations/integrations/claude-code/`.

## What they do

Cognee ships a Claude Code plugin that captures a session across six hook
surfaces and persists it into a knowledge graph. From `hooks/hooks.json`:

| Hook | Script | Direction |
|---|---|---|
| SessionStart | `session-start.py` | bootstrap + launches the idle watcher |
| UserPromptSubmit | `session-context-lookup.py`, `store-user-prompt.py` | **read** then **write** |
| PostToolUse | `store-to-session.py` | write |
| Stop | `store-to-session.py --stop`, `clear-transcript-context.py` | write, then **teardown** |
| PreCompact | `pre-compact.py` | **read** |
| SessionEnd | `sync-session-to-graph.py` | write |

The shape worth noticing: they use the hooks in **both directions**. Reads feed
the agent, writes feed the store, and one hook (`Stop`) explicitly tears context
down.

### PreCompact reads, and how

`scripts/pre-compact.py` (255 lines). Its own docstring, lines 1–11:

> Build a memory anchor before context-window compaction. Pulls a compact
> summary from three session-cache layers — recent QAs, per-step trace
> feedback, and the graph-context snapshot — and emits a markdown block the
> compactor preserves.

Mechanism, lines 217–232: it assembles a `## Cognee Memory Anchor` markdown
header plus sections, then calls **`print(anchor)`** — plain stdout, no JSON
envelope, no `hookSpecificOutput`. The markdown lands in the transcript, and
the compactor carries it through the reset.

Tuning is explicit and bounded: `_SESSION_TOP_K = 5`, `_TRACE_TOP_K = 8`,
`_GRAPH_TOP_K = 3` (lines 29–32), so the anchor cannot grow without limit.

The `main()` comment (lines 236–239) is precise about why it reads stdin at
all: to recover the host session id. *"the body is otherwise unused — PreCompact
is just a trigger."*

### The idle watcher is a detached daemon

`scripts/idle-watcher.py`, docstring lines 1–14:

> Idle watcher daemon — persists quiet Codex sessions into Cognee. Launched
> detached from `session-start.py`. Polls `~/.cognee-plugin/activity.ts` every
> `POLL_SECONDS`. When the last activity is older than `IDLE_SECONDS` and we
> haven't bridged since that point, persists the session cache and refreshes
> graph context. […] **Survives Codex crashes better than foreground hooks.**

Launch, `session-start.py:655–657`: `subprocess.Popen(...)` with
`start_new_session=True` and `stdin=subprocess.DEVNULL`. A real detached
process, not a coroutine inside the agent.

Lifecycle, `idle-watcher.py`:

- Stop conditions are enumerated in the docstring: a `watcher.stop` sentinel
  file, SIGTERM from the SessionEnd hook, or the pidfile being overwritten by a
  newer watcher.
- `_owns_pidfile()` (line 66) compares the pidfile contents to `os.getpid()`.
  The poll loop checks it (line 189) and exits with reason `pidfile_replaced`.
  That is how a restart cleanly retires the previous watcher without a race.
- Cleanup unlinks the pidfile only if it still owns it (line 239).

Tuning, with the reasoning stated in the source (lines 27–32):

```python
POLL_SECONDS     = 10   # env COGNEE_IDLE_POLL
IDLE_SECONDS     = 60   # env COGNEE_IDLE_THRESHOLD
IMPROVE_COOLDOWN = 600  # env COGNEE_IMPROVE_COOLDOWN
```

> Defaults chosen to avoid thrashing the LLM: 60s idle threshold means you have
> to actively pause a full minute, and the 10-minute improve cooldown prevents
> back-to-back improve runs when activity is sporadic.

## What is good

**1. The daemon cannot fail to run.** This is the load-bearing property. A
detached process with a pidfile does not depend on an agent remembering to act,
and it survives the agent crashing. Their own comment says it directly:
*"Survives Codex crashes better than foreground hooks."*

**2. Both directions of the compaction boundary are used.** Compaction destroys
context. Cognee treats that as a *read* opportunity — inject what matters back
in so the post-compaction agent still knows it.

**3. Bounded by construction.** Top-k limits on every source mean the anchor
has a size ceiling. No prompt-injection budget blowout, no unbounded growth.

**4. The cooldown is a real idea, not a magic number.** `IMPROVE_COOLDOWN`
exists specifically to stop back-to-back expensive runs when activity is
sporadic — the failure mode a naive idle timer produces.

**5. Explicit teardown.** `clear-transcript-context.py` on `Stop` means context
does not leak between sessions. Most integrations only add; this one removes.

## What is bad, or does not fit us

**Polling a file every 10 seconds** is crude — a filesystem watch would be
cheaper. It is defensible for portability, but it is not free.

**`activity.ts` is a `.ts` file used as a data file**, which is confusing
naming for something that is not TypeScript.

**Their write path is LLM-bearing.** Cognee's "improve" runs call a model. Open
Brain's Light stage is deliberately model-free in the write path, so their
cooldown reasoning applies to us differently — our equivalent pressure is
database load, not token spend.

**No license on cognee-integrations.** Whatever we learn here is a lesson, not a
file we could ever lift.

## Ideas we are borrowing

1. **Reliability by architecture, not policy** — if a thing must happen when the
   agent is idle or gone, it belongs in a process that runs on its own.
2. **The compaction boundary is bidirectional** — write to survive the session,
   read to survive the reset.
3. **Cooldown as a distinct control from threshold** — "is it quiet?" and "did we
   just do this?" are two different questions.
4. **Ownership via pidfile** — a newer instance retires an older one without a
   kill race.

## Shape comparison — does our shape preserve the property?

### Borrow A — the compaction boundary

| | Cognee | Open Brain |
|---|---|---|
| PreCompact does | **reads** three cache layers, `print()`s a markdown anchor | **writes** a durable checkpoint |
| Purpose | context survives the *reset* | session survives the *ending* |
| Post-compaction agent | starts with an anchor in-context | starts blank, must query |

**Verdict: our shape does NOT preserve the property. We built half the
surface.**

Verified against the live `~/.claude/settings.json`: every OB `PreCompact` hook
(policy-refresh gate, context-budget gate, memory provider) is a **writer**, and
every `PostCompact` hook is the same three writers. Nothing emits into the
compacted context.

Both directions are legitimate and we should have both. Cognee's read-anchor is
the thing that stops a post-compaction agent from re-deriving what it already
knew — the exact failure this project keeps hitting. Note their emit is trivial
(`print()` to stdout); the cost of adding it is small, and the reason it was
never added is that nothing recorded the divergence.

### Borrow B — idle detection

| | Cognee | Open Brain (DREAM-2 / #391) |
|---|---|---|
| Mechanism | detached daemon, `start_new_session=True` | rate-based trigger, specified as policy |
| Survives agent crash | yes, by construction | not addressed |
| Stop semantics | sentinel file, SIGTERM, pidfile ownership | not specified |
| Cooldown | `IMPROVE_COOLDOWN=600` separate from threshold | high-water mark, related but not the same control |

**Verdict: same idea, different shape, and the shape was the reliable part.**

#391 specifies *when* REM should fire (rate-based, low high-water mark, 6h
starvation ceiling). It does not specify *what runs it*. If the answer is "the
agent, when it notices," we have rebuilt the failure mode cognee's design
avoids. This repo already has a measured instance: the single `graph.derive`
canary dead-lettered 2026-07-23 and nothing noticed for four days, because
nothing was watching that could not also stop.

The starvation ceiling in #391 and `IMPROVE_COOLDOWN` are **not** the same
control and neither replaces the other. The ceiling is *"run eventually even if
never idle."* The cooldown is *"don't run again too soon."* We have the first;
we do not have the second.

**Local corroboration:** the autostart work done 2026-07-27 for the dogfood
clone reached the same conclusion independently — a launchd agent with a
preflight, because a process that depends on someone remembering is not a
process. Cognee arrived there first and wrote down why.

### Borrow C — teardown

| | Cognee | Open Brain |
|---|---|---|
| Stop hook | `clear-transcript-context.py` — explicit teardown | writers only |

**Verdict: we have no equivalent. UNVERIFIED whether we need one** — this review
did not establish that OB leaks context between sessions, only that cognee
guards against it deliberately. Worth checking, not worth assuming.

## Attribution

Ideas only, no code. Entered in `ATTRIBUTION.md`:

- Lifecycle capture across all six hook surfaces, used in both directions.
- Idle detection as a detached process rather than an in-agent policy.
- Cooldown as a control distinct from an idle threshold.

## Open questions this review did not settle

1. Does OB leak transcript context between sessions? (Borrow C.)
2. What actually runs REM's trigger under #391 — a process, or an agent?
3. Would a read-anchor on PreCompact conflict with the context-budget gate,
   which currently only measures and writes?
