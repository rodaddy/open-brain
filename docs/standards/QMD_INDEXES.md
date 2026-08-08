# qmd Indexes

How code search is indexed across the repo set. Three patterns, three tools; the
one you want depends on **who owns the code**, not how big it is.

The rule they all serve is in `_DOCS/STANDARDS-repo-search.md`: an agent
standing in a repo is expected to know that repo, and asking the user how their
own software works is a failure. These indexes are what make that answerable.

## Pick the pattern

| Code is... | Index shape | Tool |
|---|---|---|
| A repo you own | project-local `.qmd/` inside it | `_ob/bin/qmd-backfill` |
| Shared policy every agent needs | `global_docs_instructions` (`_DOCS` + `_ob`) | `_ob/bin/qmd-reference-index` |
| Read-only clones one repo studies | `ref-<repo>`, declared per repo | `_ob/bin/qmd-reference-index` |
| Vendored upstream nested in a repo you own | unhandled — see below | — |

## Scopes, resolved from where you stand

```
aqmd "question"                  this repo's .qmd/  +  shared policy (appended)
aqmd internal "question"         the shared policy only
aqmd -r <repo> "question"        that repo's own .qmd/
aqmd -r <repo> -r <repo> "q"     several, one labelled block each
aqmd -r a,b,c "question"         same, comma-separated
aqmd in <repo> "question"        alias for a single -r
aqmd research "question"         THIS repo's reference clones
```

**Named repos take a flag, not a positional list.** `aqmd in a b c "question"`
cannot be parsed: the question does not have to be quoted (a bare
`aqmd how does auth work` is a supported search), so nothing marks where the
repo list ends and the question begins — and a repo whose name is also a
plausible question word makes that concrete. Added 2026-07-30 (Rico); flags are
also what agents use correctly far more reliably than inferred positional
intent.

Each repo gets its **own labelled block**, never a merged result set. Merging at
query scope reproduces exactly what made the 53-repo index useless.

There is no `aqmd all`. It was removed 2026-07-29: "search everything" is what
forced the shared index to hold all 53 Development repos, and a result set
spanning every project is noise wearing the costume of thoroughness. Name the
repo you mean.

**The shared index is what the whole repo set must KNOW, not everything the
repo set contains.** `_DOCS` and `_ob` — standards, SOPs, skills, registry. It is
appended to every bare `aqmd` query so the shared rules are ambient wherever an
agent is standing, rather than something it has to remember to go look up.

It was named `fleet` until 2026-07-30, and the name was the bug: a reader who
saw "fleet" and assumed it held the *repos* was making the precise
inference that caused the 53-repo rebuild. `global_docs_instructions` states
its contents and leaves nothing to infer. The typed verb is the short
`aqmd internal`; verb and index name differ deliberately, because the verb is
typed constantly and the name is read when deciding what the thing is.

The same day, "fleet" was retired as our word for the repos themselves — it
had come to mean a qmd index, the folders under Development, and the runner
LXCs, all in the same document. **The repos are the repo set**
(`_DOCS/GLOSSARY.md`). "Fleet" now only means machines, or the `fleet-bus`
product.

It is a second query, not a merged index, deliberately: merging would copy
`_DOCS` and `_ob` into all ~45 per-repo databases, and one edit to a standard
would then leave 45 stale copies. One source, queried twice, labelled
separately.

For one month the `fleet` index was built as "every git repo under Development" — 53
repos, 1,688 documents. That duplicated all 53 per-repo indexes into one bucket
where each competed with the other 52, so cross-repo search kept returning the
same stale hits no matter what had changed. The header of
`qmd-reference-index` had warned about exactly this shape.

**References are per-repo.** open-brain studies seven memory systems; ai-agents
vendors Buzz. Neither has any use for the other's, so a repo declares its own in
`.qmd/references.yml` beside the tracked `.qmd/index.yml`:

```yaml
root: /path/to/open-brain/open-brain-local/research   # optional; default: repo root
clones:
  - cognee
  - graphiti
```

Each builds into `ref-<repo>`, so they never cross. A repo with no
`references.yml` simply has none, and `aqmd research` says so.

## The global index is retired

There used to be a whole-Development index at `~/.config/qmd/index.yml` +
`~/.cache/qmd/index.sqlite` (2.2 GB). It is gone, moved to the temp archive
2026-07-30. **Do not rebuild it.**

It is the thing every other rule here exists to prevent. Bare `qmd` scopes by
walking up for the *config*, and when it found none it did not fail — it fell
through to that global config and ran all 36 collections: minutes for `update`,
hours for `embed` with the GPU pinned, and the repo you were standing in never
refreshed. Exit 0, no warning. Removing the config removes the thing the
fallback lands on, so the failure is now loud instead of silent.

This retirement went undocumented for three days after it happened, which is
why `_DOCS/STANDARDS-repo-search.md` and four other files kept advertising a
removed `aqmd all` and this file did not mention the removal at all. A change
that lands without its docs is a trap left for the next agent.

### 1. Repos you own → project-local `.qmd/`

Each repo carries its own index. `qmd` walks up from cwd to find it, so
searching from inside the repo needs no flag and no collection name.

```bash
cd /path/to/repo
bun /path/to/open-brain/Development/_ob/bin/qmd-backfill
```

Resumable: it skips any repo that already has `.qmd/`, so rerunning it after
adding a repo indexes only the new one. It writes the allowlist config, indexes,
embeds, and sets up that repo's `.gitignore`.

**Track the config, ignore the database.** The `.gitignore` lines are:

```gitignore
.qmd/*
!.qmd/index.yml
```

`index.sqlite` is ~30MB (81MB in the worst repo) of binary git cannot
delta-compress, rewritten wholesale by every `qmd update`, tied to one
embedding model, and unmergeable — committing it adds its full size to history
per reindex, forever. `index.yml` is 5KB of text and is the expensive artifact:
the allowlist of which directories hold real source, arrived at after four
failed blocklist approaches. Tracking it puts a fresh clone one `qmd update`
away from a correct index.

It must be `.qmd/*`, not `.qmd/`. Git never descends into an ignored
*directory*, so a `!.qmd/index.yml` exception under a bare `.qmd/` silently
never matches — verified: the negation surfaces zero files. Ignoring the
directory's *contents* lets the exception fire. Same deny-with-exceptions shape
as Development's own `.gitignore`, and as the qmd allowlist itself.

Scoped update is sub-second. The shared global index walked all 36 collections
and took 30s–4min, nearly all of it other repos.

### 2. Read-only reference clones → one named index

Upstream code you read but never edit. `qmd-backfill` is wrong here for two
reasons: it dirties a third-party checkout so `git pull` stops being clean, and
per-repo indexes cannot answer the comparative question those clones exist for
("how does each of these handle X?") without N searches and a manual merge.

```bash
/path/to/open-brain/Development/_ob/bin/qmd-reference-index
# ROOT=/some/tree INDEX=othername qmd-reference-index
```

One index, many collections, **zero writes into the sources**. The index lives
in `~/.cache/qmd/<name>.sqlite` because it is rebuildable from the clones.

Live example — open-brain's seven prior-art clones in
`/path/to/open-brain/open-brain-local/research/` (cognee, cognee-integrations,
gbrain, graphiti, honcho, mem0, openhuman), declared in
`open-brain/.qmd/references.yml` and built into `ref-open-brain`:

```bash
cd open-brain
aqmd research "how are temporal relationships modeled"   # resolves from cwd
qmd query "..." --index ref-open-brain -c graphiti       # one clone
qmd search "SearchConfig" --index ref-open-brain         # BM25, ~0.1s
```

These indexes are **per-repo**, not global. Before 2026-07-29 there was a single
`research` index rooted at open-brain's clone tree, so any other repo's
references either did not exist or competed against all seven of open-brain's.

### 3. Vendored code inside a repo you own → open

Neither tool fits. `rtech-mcps` is the live case: its index is ~98% vendored
third-party MCP servers and ~1% our code, so searching for our own module
competes with eighteen other projects. Tracked as rtech-mcps#24. Known shape,
not currently a work item.

## Naming standard

Named indexes are `<purpose>`, lowercase, with no repo names baked in —
`research`, not `ob-prior-art-clones`. Established when `research` was created;
there was no prior convention.

**Always `--index <name>`, never `INDEX_PATH`.** `--index` swaps both
`~/.cache/qmd/<name>.sqlite` and `~/.config/qmd/<name>.yml`. `INDEX_PATH` swaps
only the database and silently inherits the global collection list, which mixes
unrelated code from other repos into results — a wrong answer that looks like a right one.

## Why the pattern is an allowlist

Both tools generate `pattern:` as an **allowlist**: deny everything, admit the
directories `git ls-files` proves hold source. Not a broad mask minus
exclusions.

A blocklist cannot work in a repo that vendors other repos, because one
directory holds both:

```
ai-agents/platforms   42 tracked files    89,433 on disk
ai-agents/agents      22 tracked files   252,494 on disk
```

Excluding `platforms/**` drops the 42 real files; keeping it indexes 89k. Four
blocklist approaches were measured against a real answer of ~283 files:
`.gitignore` translation (38,568 — the bulk was never in `.gitignore`),
excluding untracked top-level dirs (38,568), `git check-ignore` (flags none of
them), nested-`.git` detection (the biggest offender is a plain directory).
Unfiltered: 121,415.

Two rules keep it correct:

1. **Each admitted directory contributes only its own files.** Never `/**/`.
   With recursion, one tracked file under `platforms/` readmits all 89,433.
2. **The directory list comes from `git ls-files`.** Git already knows what
   belongs.

Deliberately-gitignored source trees that `git ls-files` cannot see are named
back in via `_ob/etc/qmd-index-overrides.yml`.

Result across 38 owned repos: 7,170 files, 608 MB, none over 2,000 files.

## Requirements

Both tools need the fork's array-pattern support: `rodaddy/qmd`, branch
`rodaddy/v2.6.3-repo-local`, patch 3 in `qmd/FORK.md`. Upstream issue
tobi/qmd#798. **A stock qmd 2.6.3 rejects the array pattern.** Confirm with
`qmd --version` — it should report a fork commit.

qmd 2.6.3 also dropped `.gitignore` support that 2.1.0 had, which is why the
allowlist is generated rather than inherited.

## Not automatic, by design

`qmd/CLAUDE.md` says never run `collection add`, `update`, or `embed`
automatically. Both tools are deliberate operator-invoked exceptions.

Embedding is GPU-bound and cannot be parallelized across repos, so a full
rebuild is minutes. Re-embedding *unchanged* content is ~0.29s because
embeddings are content-hash keyed — so routine `qmd update` after edits is
cheap, and only a first build or a large upstream pull is expensive.
