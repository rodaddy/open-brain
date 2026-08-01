# Coding Standards

## Default Rule

Follow the repo's own standards first. If a repo has no stricter rule, use this
file.

## Say What You Mean

Verify before you assert. Every factual claim about the system -- what a file
contains, what a command did, what state something is in, whether a thing exists
-- must come from something you actually checked in this session, not from
memory, inference, or what was probably true.

Spending five minutes digging to find the real answer is always correct. One
confidently wrong sentence is not: it sends the operator down a false path, and
the round trips to undo it cost far more than the check would have.

Name the exact object. Not "the current branch" when you mean "whatever branch
each repo has checked out." Not "in there" when you mean a specific path. An
imprecise phrase does not read as vague -- it reads as a specific claim, usually
the worst one available. Before stating something, check whether the wording
could be read as a thing that is explicitly banned here (worktrees in
Development, `/tmp`, pinning, auto-merge, system Python). If it could, rewrite
it. Do not rely on the reader inferring the charitable meaning.

The same applies to hedges. "Should be fine" is not a finding. Say what was
verified, and say plainly what was not: "I confirmed X; I did not check Y."

When you do not know, say you do not know, then go find out. "I don't know yet"
is a complete and acceptable answer. A guess presented in the grammar of a fact
is not.

### The confident idiot is the worst failure mode

Being wrong is recoverable. Being wrong *confidently* is not, because it removes
the signal that anything needs checking. The operator trusts that research was
done, builds on the claim, and finds out later -- after the cost compounds.
Every hedge you drop to sound authoritative transfers risk onto someone who
cannot see that you skipped a step.

**Read past the README.** When told to look at a repo, a README summary is not
an answer -- it is the marketing copy, and it is frequently stale. Read the
actual source, the tests, the config, the recent commits, the issues. The
question "what does this do" is answered by what the code does, not by what the
docs claim. State which files you actually read.

Concretely, before asserting:

- **A file's contents** -- read it now, in this session.
- **What a command did** -- read its real output, not your expectation of it.
- **That something exists or does not** -- check the path, the process, the
  config key. "Not found" needs a search that could have found it.
- **That a mechanism is enforced** -- find the thing that enforces it and
  confirm it is installed and wired. A rule naming a hook that does not exist
  is worse than no rule at all.
- **How a repo or tool works** -- read its source. Not its README, not its name,
  not a similar tool you know.

## Workspace Hygiene

- Put files in the repo/folder that owns the work.
- Do not pollute `/Volumes/ThunderBolt/Development` with random test files,
  scratch scripts, downloaded artifacts, temporary reports, or generated data.
- Use the configured temp workspace for temporary files and one-off tests. On
  Rico's Mac this is `/Volumes/ThunderBolt/_tmp`; on cc-* boxes this is
  `/mnt/collab/tmp_space`. Keep temp work under
  `{temp_workspace}/{project-or-repo}/...`.
- **NEVER `/tmp`, `$TMPDIR`, `mktemp -d`, or any other OS temp dir — HARD RULE.**
  This is not a style preference. `/tmp` is process- and sandbox-local: a runner,
  a Codex sandbox, and the host each see a *different* `/tmp`, so an artifact
  written there is invisible to every other participant and vanishes without
  notice. The configured temp workspace is shared and inspectable, which is the
  entire point. This rule is violated most often by reflex — a one-line
  `> /tmp/foo.txt` inside a larger correct task — so treat any `/tmp` path in a
  command you are about to run as a bug, the same way you would treat `rm -rf`.
  If a tool demands an OS temp path, point it at
  `{temp_workspace}/{project-or-repo}/_scratch/`.
- **Every `{temp_workspace}/{project-or-repo}` area uses the standard `_*`
  layout, and it MUST be created with
  `bun _ob/scripts/init-temp-workspace.ts <repo>` — not by hand.** Creating the
  buckets manually is how they end up subtly wrong (one missing, one misspelled,
  no README), which defeats the point of a fixed layout. The script is
  idempotent, so run it whenever you are unsure; `--check` verifies an existing
  area and reports stray folders. This runs at repo spin-up
  (`_DOCS/REPO_BOOTSTRAP.md`) and again from `sync-repo-standards.ts`.
  Do not create bare topic folders at the area root; a flat root of fifty
  lane-named directories is unnavigable and is how stale worktrees hide for
  months. File work into a bucket:

  | Folder             | Holds                                                        |
  | ------------------ | ------------------------------------------------------------ |
  | `_worktrees/`      | git worktrees — **only** via `git worktree add/move`, never `mv` |
  | `_reviews/`        | review findings, PR bodies, swarm output                     |
  | `_builds/`         | build/dist/package output, installers                        |
  | `_research/`       | cloned third-party repos and reference material              |
  | `_validation-runs/`| validation runs, caches, throwaway venvs                     |
  | `_smoke/`          | smoke tests, canaries, disposable clusters                   |
  | `_goal-runs/`      | goal-run prompts and transcripts                             |
  | `_scratch/`        | everything else short-lived                                  |
  | `_archive/`        | stale or no-longer-needed agent artifacts                    |

- Git worktrees under `_worktrees/` are moved with `git worktree move` and
  removed with `git worktree remove`. A plain `mv` or `rm -rf` breaks the gitdir
  link and strands the registration; `git worktree list` then reports a
  `prunable` entry that no longer matches anything on disk. Before removing any
  worktree, check `git status --porcelain` inside it for uncommitted work and
  confirm its branch is merged or pushed — the directory is not the only copy
  only if the branch exists on the remote.
- Every `{temp_workspace}/{project-or-repo}` area must have an `_archive/`
  folder for stale or no-longer-needed agent artifacts.
- Temp workspace paths, including `_archive/`, have no lifetime persistence
  guarantee. Anything that must be retained belongs in the owning repo/project
  folder or another durable user-approved location, not in temp. A `_keep/`
  folder may be used only for short-term explicitly preserved temp state.
- Use visible repo folders such as `reports/`, `docs/`, `planning/`, `fixtures/`,
  or `tests/fixtures/` only when the output is meant to be a durable project
  artifact.
- Move your own temporary files into the matching `_archive/` folder after
  validation unless the user asks to keep them active. Archiving current-run
  temp files under the configured temp workspace does not require approval.
- MUST NOT use raw `rm -f` or `rm -rf` for temp cleanup in agent workflows. Ask
  only before touching files outside the configured temp workspace, durable repo
  artifacts, user-created files, or ambiguous paths.
- **No hidden (dot-prefixed) folders for project content — HARD RULE (Rico
  2026-07-03, reaffirmed 2026-07-09).** Hidden folders are a pain on macOS.
  The only permitted dot-paths are tool-mandated ones with no rename lever:
  `.git/`, `.github/`, `.gitignore`, `.gitattributes`, `.env*` (gitignored).
  Everything else uses a visible name: `_reports/` (never `.reports/`),
  `_githooks/` (git's `core.hooksPath` makes the name free), `_archive/`,
  `_tmp/`, `_ob/`, `_DOCS/`. When touching a repo that still has a banned
  dot-folder, migrate it (content preserved) rather than adding to it.

## Shared Sites (agent-viewable HTML/docs)

Rendered HTML that is meant to be **viewed** (reference pages, showcases, plan/
status dashboards) and **edited by agents in real time** lives in the shared
collab sites layer, not in a git worktree and not scattered in repos. This is the
durable home so no one is ever pointed at a disposable worktree path.

- Location: `/mnt/collab/sites/<repo>/` — one folder per repo/project. Collab is
  `/mnt/collab` on every host (the Mac has `/mnt` → `/Volumes` symlinked), so the
  path string is identical on the Mac and every LXC. Never bookmark or reference a
  `.claude/worktrees/...` or `_tmp/.../worktrees/...` HTML path.
- Fixed subfolder layout inside each `<repo>/`:
  - `assets/` — images and other media referenced by the pages.
  - `plans/` — plan/status/dashboard HTML tied to active work.
  - `reference/` — longer-lived reference and showcase HTML.
- Prefer a single self-contained HTML file per page (images base64-embedded,
  CSS/JS inline) so it opens by `file://` with no server and travels intact.
- When an HTML page moves out of a repo into `sites/`, remove it from the repo
  (git rm) and leave a short pointer `README.md` at its old location naming the
  new `/mnt/collab/sites/<repo>/...` path. One canonical copy — no duplicated,
  drifting HTML tracked in git alongside a live collab copy.
- Repo-owned machine-readable specs (`*.RUN.md`, `*.verify.sh`, markdown plans)
  stay git-tracked in the repo; only the rendered HTML moves to `sites/`.
- No index-generation machinery for now: this layer is intentionally simple until
  it becomes the document root of the `10.71.20.35` web-server suite, at which
  point these `file://` paths become real served URLs with no restructuring.
- Still governed by collab safety: no git-write or risky writes to the collab
  share from the Mac (SMB cannot handle ZFS symlinks). Plain `mkdir`/`cp` of
  non-symlink files from the Mac is fine; git operations run server-side on an LXC.

## In-Repo Standards (required)

Every repo carries the standards that apply to it, in its own `_DOCS/`. An agent
working in a repo reads that repo's files; requiring it to walk up to
`/Volumes/ThunderBolt/Development/_DOCS/` means the rules are followed only when
someone remembers to look. That is not hypothetical — the temp-workspace rules
lived only here and were violated repeatedly by agents that never opened this
file.

- Generate them with `bun _ob/scripts/sync-repo-standards.ts <repo>`. This is
  part of repo spin-up (`_DOCS/REPO_BOOTSTRAP.md`) and is what
  *"make sure this repo is up to standards"* runs.
- Bundles are **stack-gated**: `STANDARDS-core.md`, `-observability.md`, and
  `-git.md` always; `-typescript.md`, `-python.md`, `-ci-security.md` only when
  the repo actually has that stack. Same rule as bootstrap tooling — no
  speculative Python standards in a TypeScript repo.
- The command also creates the repo's temp-workspace buckets and reports
  non-doc gaps (missing `_githooks/`, hidden dot-folders, absent CI). Those are
  **reported, never auto-fixed**: they edit files the repo owns.
- `--check` exits non-zero when a copy is stale or a bucket is missing, so it
  can gate CI. `--all` sweeps every repo under Development.

**Generated copies are never hand-edited.** Each carries a `source-hash` of the
section it came from, which gives three states:

| State      | Meaning                          | Action                              |
| ---------- | -------------------------------- | ----------------------------------- |
| `ok`       | matches source                   | none                                |
| `STALE`    | source changed since generation  | re-run the sync                     |
| `MODIFIED` | the local copy was hand-edited   | move the change into `_DOCS/`, then re-run |

A `MODIFIED` copy is the dangerous one: it reads as authoritative while
contradicting the source. The sync **reports it and refuses to overwrite it**,
so an edit is never silently destroyed — but the fix is always to move that
change into the source document here, never to keep it local.

Copies going stale is expected and is not a failure of the model; it is why the
sync command exists. Re-run it rather than reasoning about whether a local copy
is current.

## Quality Bar

- Code must be formatted, lint/typecheck friendly, and avoid avoidable editor
  diagnostics.
- Implement the minimum code that solves the problem. Avoid speculative systems.
- Touch only what the task requires. Clean up only your own mess.
- Prefer existing project patterns, helpers, and architecture.
- Add abstractions only when they remove real complexity or match a local
  pattern.
- Split large files before they become maintenance problems. Around 600 lines
  should trigger a split review; 750 lines is a hard warning unless there is a
  concrete reason.

## Control Flow (non-negotiable, all languages)

Rico's rules, 2026-07-30. Language-agnostic; the per-language documents own the
spelling and the linter config that enforces them.

**NEVER nest conditionals.** An `if` inside an `if` is a hard anti-pattern, not
a preference. Each nesting level multiplies the paths through a function: three
levels of two-way branching is eight paths, nobody writes eight tests, so most
ship unexercised. This is the same reason as the testing rule below — untestable
shapes are the problem, and nesting is how functions become untestable.

**NEVER write a long if/elif chain.** Its complexity rises forever, and every
new case means re-reading the whole ladder to find where the new one belongs.

**PREFER an enum plus a table over conditionals at all.** A stack of sequential
`if`s is not the destination — it is nesting laid on its side, still one branch
per line to read and to test. Turn the rules into DATA:

- **Enum** for the closed set of cases. The type checker then catches a
  misspelled member; a bare string typo ships silently. It also gives each case
  exactly one spelling, so logs, tests, and API responses cannot drift apart.
- **Table** (dict dispatch, or a tuple of predicate/result pairs) for the rules.
  Adding a case becomes one row rather than one branch, complexity stays
  constant as the rule set grows, and the table can be asserted on in a test
  without invoking the function that consumes it.
- **`match`/`switch`** when branching on SHAPE rather than a single key, where a
  table cannot express the destructuring.

Order of preference: enum + table, then guard clauses (fine for two or three
genuinely unrelated checks), then extracting a function, then dispatch on value
or shape. Plain nested conditionals are not on the list.

Worked example, verified against `ruff` and `mypy --strict` on 2026-07-30:
`_DOCS/STANDARDS-python.md` `## LAW: flat control flow`. Three validation rules
in a table, one branch total; ten more rules would add ten rows and still one
branch.

**Enforcement is per-language and must be real.** Python: `PLR1702`
(nesting — requires `preview = true` or it silently never fires), `PLR0912`
(branch count), `C901` (complexity). TypeScript: the equivalent
`complexity`/`max-depth` rules. A rule with no configured mechanism is a
principle for human review and must not be described as mandatory.

## Minimal Correct Change

This is a correctness rule, not a style preference.

Aliases Rico may use for this rule: `PT protocol`, `Ponytail`, `pony style`,
and `Ponytail-style review`.

If this rule conflicts with speed, convenience, or a smaller-looking diff, this
rule wins.

This is the default mode for Codex, Claude, and other Development agents unless
Rico explicitly says otherwise.

Critical mode is NOT a default. It is invoked deliberately with
`/critical-mode`. A mode that is always on stops being a mode: the challenge
degrades into a required field that gets written and ignored, and invoking it
buys nothing because there is no contrast to switch into.

What is always on is narrower and does not need a toggle: do not agree
reflexively, and do not assert what you have not verified (`## Say What You
Mean`). Disagree when you have a real, concrete reason. Do not manufacture a
concern to look rigorous -- a challenge nobody believes trains the reader to
skip all of them.

Do not choose the easiest implementation path. Choose the smallest path that is
correct at the owning boundary.

Before editing, identify the owning boundary in one sentence:

- the shared function,
- the source-of-truth module,
- the repo-owned workflow,
- the trust boundary,
- the data model,
- the external API contract,
- or the user-visible behavior being changed.

If you cannot identify the owning boundary, stop and inspect more code.

Mandatory rules:

- Fix bugs at the owning boundary. Do not patch only the reported caller when
  sibling callers can still fail.
- Reuse existing repo helpers, types, scripts, config, and patterns before
  creating new ones.
- **Look before you leap.** Before writing an implementation of anything,
  check what already exists: a repo helper, a sibling repo doing the same job,
  a repo-set-standard library, the standard library. Search first, write second.
  A spec tells you what the output looks like; a working implementation tells
  you which runtime behaviors bite.
- **Do not reinvent the wheel.** Prefer, in order: an existing repo helper → a
  well-known maintained library for that job → the standard library or platform
  feature → a custom implementation. A new dependency is the *cheaper* choice
  when the alternative is re-implementing a solved problem.
- On a NEW repo or a new subsystem, "no dependency is installed yet" is not a
  reason to hand-roll. An empty dependency list is the START of the list above,
  not the end of it. This is the most common way this rule gets read backwards.
- Do not write your own logger, HTTP client, retry/backoff, date/time math,
  argument parser, config loader, schema validator, crypto, or file-rotation
  logic. These are solved. Their failure modes are ones you rediscover in
  production, not in review. Examples already used in this repo set — TypeScript:
  `pino`, `zod`, `undici`; Python: `loguru`, `pydantic`, `httpx`, `tenacity`.
  Examples, not an allowlist: prefer whatever the repo set already uses for the
  same job.
- **Adding a well-known, maintained library for one of those jobs needs no
  justification. Hand-rolling one does** — state in the code why every
  candidate library was unsuitable. Today the burden sits backwards: nobody
  questions 500 lines of custom logger, everybody questions one import.
- **KISS, and it is the same rule as Pony.** Minimum owned surface area means
  minimum code *you* maintain, not minimum dependencies. 900 lines you own is
  far more owned surface — and far more to get wrong — than one import of a
  library thousands of services already exercise. Choosing the library IS the
  minimal correct change.
- When you do add a library, look before you leap there too: maintained, typed,
  and ideally already used elsewhere in the repo set. Do not trade a hand-rolled
  bug for an unmaintained dependency.
- Delete or simplify existing code before adding new code when both solve the
  same problem.
- Do not add abstractions, frameworks, queues, services, config systems, generic
  helpers, or future-proofing unless the current task requires them or the repo
  already uses that pattern for the same job.
- Do not touch unrelated files to make the work feel cleaner.
- Do not skip a required test, typecheck, build, migration, doc update, board
  update, or safety check to keep the diff small.
- Do not call the change minimal if it avoids the hard part of the task.

Never minimize away:

- explicit user requirements
- security/auth boundaries
- input validation at trust boundaries
- data-loss prevention
- operationally meaningful error handling
- accessibility
- audit/logging needed for debugging or compliance
- repo, git, infra, OB, or deployment safety rules

If two paths are available, the correct path is the one that preserves all
callers, invariants, and source-of-truth ownership. Take that path even when it
requires more code or more files.

The goal is minimum owned surface area after correctness is satisfied. It is not
minimum effort, minimum files, minimum tests, or minimum dependencies.

Owned surface is code you are responsible for when it breaks at 3am. A
well-known library is not owned surface; a hand-rolled equivalent is. Reaching
for the library is therefore the Pony-correct move, not a shortcut around it.

## Testing (non-negotiable, all languages)

Language-neutral, like the Observability rules. A language never gets an
exemption from the rule; only the tool names differ, and those are given inline
as examples rather than restated in a per-language section. Two copies of a
non-negotiable rule drift, and the drift is always silent.

### Test behavior, not coverage

**Coverage percentages and line/branch targets are NOT acceptance criteria.**
Do not add coverage gates, badges, or goals as delivery gates — no
`--cov-fail-under` (pytest), no `coverageThreshold` (vitest/jest), no equivalent
in any runner. Coverage may be inspected only as a diagnostic pointing at an
obviously untested behavior boundary.

What is wanted instead: **functional input/output tests at the function, class,
or public boundary.** Given an input and external state, assert the
caller-visible result — the returned value, serialized response, emitted event,
persisted row, exit code, or stdout/stderr.

A test that raises coverage without asserting behavior is worse than no test: it
reports the line as covered, so nobody looks at it again.

### Do not assert implementation internals

Mocks and fakes may simulate databases, HTTP, message buses, clocks, and
filesystems — but assertions must target observable behavior. Do not assert SQL
text fragments, parameter positions, private helper calls, cursor call order,
captured-query arrays, mock call counts, or any other internal merely to
increase coverage.

The test to write is the one that fails when the behavior breaks and passes when
the implementation is rewritten. If a refactor that preserves behavior breaks
your test, the test was asserting the wrong thing.

### Exercise the real boundary

Do not reimplement private production logic inside a test. Call the real public
module, command, endpoint, or tool. A test that reimplements the logic it checks
proves only that the copy agrees with itself.

### Prove the test can fail

A green test is evidence of nothing until you have seen it go red. Before
trusting a new test, break the behavior it covers — mutate the predicate, drop
the guard, reverse the ordering — confirm the test fails, then restore. State
the mutation in the commit or the test's docstring.

This is how an assertion that encodes the WRONG expected behavior gets caught,
and it is the only cheap way to catch it.

### Cover the failure paths as behavior

Expected failures are behavior: assert the stable error category or message,
status or exit code, **the absence of mutation**, redaction, and retry/no-retry
semantics. "Nothing was written" is an assertion, not an assumption.

### Realistic boundary tests where it matters

Critical auth, tenant/namespace isolation, concurrency and compare-and-swap,
migrations, protocol contracts, and destructive operations need at least one
realistic boundary or integration test in addition to fast fakes. A fake decides
its own answer, so it cannot prove the database, the wire, or the permission
check actually behaves.

### Same paths everywhere

Local verification, pre-push hooks, and CI must lint, typecheck, and test the
same source, test, and script paths. A narrower local or CI scope is a policy
gap, not a convenience.

## Observability (non-negotiable, all languages)

Logging and error handling are **language-neutral requirements**. The rules below
apply to every Development repo. The language documents named under
`## Language Standards` give the concrete spelling; a language never gets an
exemption from the rule itself.

Prior to 2026-07-25 these rules lived only inside this file's Python section, and
TypeScript was never held to them. The measured result across the repo set: roughly
**1,100 bare `catch {}` blocks**, at 11-65 per 100 TypeScript files — except in
`king-capital`, the one repo with a written TypeScript standard, which has
**0.2 per 100**. A rule that nothing enforces is not a standard.

### Every outcome emits a signal

The single most important rule, and the reason for all the others:

**Absence of a log line must never be used as proof of success.** Every
successful operation emits its required exit/result log, and every degraded,
fallback, skipped, or partially-completed path emits a warning or error. A path
that fails and says nothing is indistinguishable from a path that never ran,
which makes the system undebuggable and unalertable.

### Log at five points

Entry (debug), exit/result (info), failure (error), fallback/degraded path
(warning), guard/limit trigger (warning). Include identifying context — host,
user, profile, path, and the operation's correlation id.

Prefer a wrapper that emits entry/exit/duration/failure automatically over
asking each call site to remember five calls. Discipline has already been tried
and measured; make compliance the shorter path.

### Never swallow an error

- No bare `except:` / `except: pass` (Python) and no `catch {}` (TypeScript).
- Every caught exception is logged at an appropriate level, then either
  re-raised or handled.
- **Catch blocks that return a fallback value must log before returning.** Never
  `catch { return null }` silently.
- Every intentional fail-open is a **documented decision in the code**, stating
  why, not an accident of an empty block.
- A bound-but-unlogged catch (`catch (e) {}` with no logging) is the same
  violation as an empty one; linting for empty blocks alone is insufficient.

### Structured output and required fields

- Logs are **structured JSON**, one object per line, on stdout and a rotating
  file. Applications do **not** ship their own logs: Alloy/Promtail on the host
  tails them into Loki (`obs-loki`, px02), and Grafana owns dashboards and
  alerting. The app must never know its destination.
- Every line carries: `timestamp`, `level`, `message` (a stable event name, not
  a sentence), `service`, and a `correlation_id` that ties one operation's
  five points together.
- Local rotation: **1 MB** per file, **3** rotated files retained. Derive a
  per-worker path when more than one process writes, so two writers never share
  a rotation chain.
- Log levels come from configuration, and an invalid value fails loudly at boot
  rather than silently defaulting.

### Never log secrets or private content

Never log secrets, tokens, auth payloads, or private user content — sanitized
summaries only. Never log raw model output; wrap it in a sanitizing preview
helper first. Prefer a logger with declarative redaction over remembering at
each call site.

- Recursive sanitizers must treat key names case-insensitively and normalize
  separators before matching. At minimum redact `password`, `passphrase`,
  `secret`, `token`, `api_key`, `authorization`, `cookie`, `session`,
  `credential`, and `private_key`, including common prefixed/suffixed forms.
- Sanitization must be bounded: default to at most 4 container levels, 50 items
  per container, and 200 characters per retained string. A lower repo-local
  limit is allowed. When a limit is reached, emit only the value's type plus
  shape/count metadata (for example, mapping key count, sequence item count, or
  original string length).
- Never fall back to arbitrary object `repr`/stringification. Unknown objects
  and exceptions get an allowlisted type/shape/count summary; errors may expose
  an allowlisted stable category and remediation-safe message only.
- Observability applies to meaningful operations and outcomes. It does not
  authorize logging every function call, input, output, or object graph.

### Crash visibility

Process-level handlers must log before exit (`uncaughtException` and
`unhandledRejection` in TypeScript; the equivalent excepthook in Python).
An unlogged crash leaves nothing to diagnose.

### Retries and outbound calls

Bounded attempts, log each failure with its attempt count, re-raise on
exhaustion — never an unbounded or silent retry loop. Outbound network calls
require explicit timeouts, bounded response handling, and safe/redacted errors.

### Enforcement (this is the part that makes it real)

Lint rules and pre-push hooks must reject violations mechanically, and hooks and
CI must run the same commands over the same paths. Required checks:

- no empty catch/except blocks
- **every catch/except body contains a log call or a re-raise** — a custom rule;
  stock "no empty block" checks miss the bound-but-unlogged case
- no direct console/print calls outside the logging module
- no floating promises (TypeScript)

## Language Standards

Everything above this line applies to all languages. Everything below is a
pointer.

Language-specific rules live in their own documents. **Read the one for the
language you are writing before you write it** — they are the authority for
toolchain, layout, typing, logging spelling, documentation, and what blocks a
commit.

| Language | Document | Worked example |
|---|---|---|
| Python | `_DOCS/STANDARDS-python.md` | `_DOCS/python-exemplar/` |
| TypeScript | `_DOCS/STANDARDS-typescript.md` | none yet |

These were split out of this file on 2026-07-30. The reason is in the split
itself: this document had reached 735 lines with two language sections buried in
the middle, and a standard that long is skipped rather than read. Each language
doc is self-contained and sized to be read in one sitting; this file keeps only
what is genuinely cross-language.

A worked example is not decoration. It is a real, runnable application that
implements every rule in its standard, so a rule can be checked against working
code instead of argued about. When a standard and its example disagree, the
example is wrong and gets fixed — an example that violates its own standard
teaches the exception.

### If your code is behind these standards

Existing repos are not expected to already comply. They are expected to move,
and to move in an order that holds.

**Do not attempt a single sweeping "bring it up to standard" change.** It
produces an unreviewable diff, mixes mechanical reformatting with real
behavioural fixes, and — the common failure — lands the rules before the
mechanism that keeps them, so the repo drifts straight back.

Order, each landing on its own branch and PR:

1. **Enforcement first: hooks in `_githooks/` with per-repo `core.hooksPath`.**
   Nothing else survives without this. Verify with
   `git config core.hooksPath` and by making a deliberately non-compliant commit
   that must fail.
2. **Formatter and linter.** One tool, one config. This diff is large and purely
   mechanical, so it lands alone and is reviewed by confirming the test suite is
   unchanged.
3. **Type checking**, strict, narrowing per-module exceptions as you fix them
   rather than blanket-ignoring.
4. **Validated models and configuration** — schema types at the boundary,
   configuration in one module that fails fast.
5. **Documentation generation** and the docstrings it requires.
6. **Split oversized files.**

Step 1 first, always. Every later step states a rule, and a rule with no
mechanism behind it is a comment.

**Audit before you plan.** Do not assume a documented mechanism is running.
Confirm the hook path is not shadowed, the checks name paths that actually
exist, and the generator fails rather than skips. All three of those were found
broken in a repo whose documentation described them as mandatory — see
`_DOCS/STANDARDS-python.md` `## The one idea behind all of it` for what that
cost and how it was found.

**File an issue for what you do not fix.** A known gap left untracked is
indistinguishable from a gap nobody noticed.

## Comments

Use comments sparingly. Add comments where they prevent expensive re-parsing of
non-obvious logic. Do not narrate obvious assignments or control flow.

## Verification

Before calling implementation done, run the relevant test, lint, typecheck,
build, syntax check, or focused manual validation. If verification cannot run,
state the exact blocker and residual risk.

## CI security baseline

- Every GitHub Actions workflow must declare an explicit least-privilege
  `permissions:` block.
- Pin third-party actions by full commit SHA, not mutable major-version tags.
- Never interpolate GitHub event/input expressions directly into shell `run:`
  blocks; pass them through `env:` and quote the shell variable.
- Security checks must remain visible. Do not hide failures with `|| true`.
- Pre-push hooks and CI must cover the same paths and commands.

## Secrets

Never commit secrets. Do not put secret values in logs, fixtures, generated
reports, PR bodies, issue bodies, or screenshots. Env/config evidence may list
variable names only.

## Gotchas

- **A file can be committed and still unfindable by `qmd`/`aqmd`** -- two
  separate defects, both measured 2026-07-30, both silent. The allowlist in
  `.qmd/index.yml` is a SNAPSHOT of directories that existed at first index, and
  `aqmd up` indexes against existing patterns rather than creating new ones, so
  a repo that gains a new top-level directory misses it forever (140 tracked
  files hidden in `rtech-consulting`). Separately, the allowlist used to be
  built from `git ls-files`, making untracked work structurally invisible
  (~1,400 files across the repo set; 46 of 53 repos could not search their own synced
  `_DOCS/STANDARDS-*.md`). Fix and full diagnostic:
  `_DOCS/STANDARDS-repo-search.md` `## GOTCHA: a file can be present, committed,
  and still unfindable`. Short version: `REGEN=1 ONLY_REPO=<repo>
  _ob/bin/qmd-backfill && aqmd up`, and never delete `.qmd/index.yml` to force
  a rebuild.
- **macOS TCC re-prompts per Claude Code version, filling Files & Folders with
  dead rows** -- the installer points `~/.local/bin/claude` straight at a
  version-numbered binary (`~/.local/share/claude/versions/2.1.220`), and TCC
  keys permissions on the resolved binary path, so every update looks like a
  new app. Fix: point the symlink at
  `~/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude`, which is the
  SAME FILE (verified: inode 721245367, link count 2 -- the installer
  hard-links each release into the bundle) but carries a stable signed identity
  (`com.anthropic.claude-code`, Team `Q6L2SF6YDW`). That bundle is the CLI, NOT
  the desktop app (`LSUIElement=true`, no window; the GUI app is
  `/Applications/Claude.app`). `~/.local/bin/claude-pin-current` re-pins if an
  update reverts it, and refuses when the inodes differ so a stale bundle
  cannot silently downgrade the running version. Old rows must be removed by
  hand in System Settings, after the new path has been granted access once.
  This is the general shape of the `versions/` + `current` pattern: never point
  a stable name at a version-numbered file.
- **Canonical Python standards** -- Before scaffolding or reviewing Python in
  any Development repo, read `_DOCS/STANDARDS-python.md` and check the worked
  example at `_DOCS/python-exemplar/`; functional input/output behavior is the
  acceptance model, never a line coverage target or assertions against
  SQL/query internals.
- **Canonical TypeScript standards** -- Before scaffolding or reviewing
  TypeScript, read `_DOCS/STANDARDS-typescript.md` together with
  `## Observability (non-negotiable, all languages)` above and
  `king-capital/docs/coding-standards.md` as the proven source. Do not treat
  logging or error handling as Python-only rules; that reading is what produced
  roughly 1,100 bare `catch {}` blocks across the repo set while CI stayed green.
- **`catch {}` is the TypeScript `except: pass`** -- and a bound-but-unlogged
  `catch (e) {}` is the same violation. When auditing, count both: an
  empty-block linter alone will report a repo as clean when most of its catch
  sites still discard the error. Highest risk is a swallowed error in the
  diagnostic and durability paths -- log sinks, health checks, WAL recovery --
  where silence removes the only evidence you would have had.
