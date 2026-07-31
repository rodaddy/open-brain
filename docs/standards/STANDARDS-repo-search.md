# Repo Search Standards

## You are in this repo. You own it.

An agent working in a repo is expected to know that repo. Asking the user how
their own software works — what a module does, where a thing is configured,
whether a helper already exists — is a failure, not diligence. The answer is
in the tree you are standing in, and you have a search index for it.

**Search before you ask.** Every question about this repo's code, config,
history, or structure gets a search first. Ask only about intent, priorities,
and decisions that are not written down anywhere.

That includes the repos this one connects to. "It lives in another project" is
not a reason to ask — `aqmd -r <repo> "question"` searches a named repo without
leaving this one.

This is not a suggestion to be thorough. It is the difference between an agent
that owns a repo and one that treats the user as its documentation.

## `aqmd` — the whole interface

One command. It works from any repo, needs no flags, and cannot accidentally
run every repo in the set.

```bash
aqmd "how does deployment roll back"   # THIS repo + the shared policy
aqmd up                                # refresh after you write files
aqmd -r open-brain "memory adapter"    # ONE named repo, from here
aqmd -r open-brain,qmd "chunking"      # SEVERAL, one labelled block each
aqmd internal "temp workspace policy"  # the shared _DOCS/_ob policy only
aqmd research "temporal edges"         # the prior-art clones only
aqmd                                   # what am I scoped to?
```

That is the entire thing to remember. The sections below explain when each
matters; you do not need them to start.

### Refreshing after you write files

**`aqmd up`.** Nothing else.

Content is keyed by hash, so it only processes what actually changed. An
unchanged repo costs ~1.8s and does no work; a repo with a handful of new files
costs a few seconds. Nothing is erased and rebuilt, so it is safe to run every
time you finish writing — and safe to wire to a hook.

**Why not bare `qmd update; qmd embed`?** Because those are correct only when
the repo has a `.qmd/index.yml`. qmd scopes by walking up for the **config**,
never the database. With no config it does not fail — it silently falls through
to the shared index and runs all 36 collections: minutes for `update`, **hours**
for `embed`, the GPU pinned so every other agent's embed crawls, and the repo
you were standing in never refreshes. Exit code 0, no warning.

You cannot tell a scoped run from a whole-repo-set run by looking at it. `aqmd` resolves
the config first and refuses to run unscoped, so a missing index costs you a
one-line error instead of a wasted GPU hour.

### Cross-project: `aqmd -r <repo>`

Projects here are interconnected, and an agent in one repo regularly needs
something from another. **Do not `cd` to the other repo, query, and `cd` back** —
that dance is why agents skipped it and asked the operator how their own
software works.

```bash
aqmd -r rtech-infra "how does caddy route traffic"    # one named repo
aqmd -r open-brain -r qmd "how is chunking done"      # several, one block each
aqmd -r open-brain,qmd "how is chunking done"         # same, comma-separated
aqmd in rtech-infra "how does caddy route traffic"    # alias for a single -r
```

Each named repo is queried against **its own `.qmd/` index** — the same index it
would use if you cd'd into it — and each gets its own labelled result block.
Your working directory is irrelevant and your local index is untouched. This
works even in a repo that has no local index of its own.

**Results are never merged.** Merging at query scope reproduces exactly what
made the old 53-repo index useless: every repo competing with the other 52, so a
stale hit outranked the right answer.

**Repos take a flag, not a positional list** (Rico, 2026-07-30). `aqmd in a b c
"question"` cannot be parsed, because the question does not have to be quoted —
a bare `aqmd how does auth work` is a supported search — so nothing marks where
the repo list ends and the question begins. A repo whose name is also a
plausible question word makes that ambiguity concrete.

A name that is not a Development repo is looked up among the reference clones
declared by any repo's `.qmd/references.yml`, so you do not need to know which
index owns it.

### Prior art: `aqmd research`

Six upstream clones (mem0, graphiti, cognee, cognee-integrations, gbrain,
honcho) are checked out at `/Volumes/ThunderBolt/open-brain-local/research` as
reference material. They are **read-only** and share one index, so nothing is
ever written into them — no `.qmd/` per clone, no dirtied `git pull`.

```bash
aqmd research "how does temporal edge invalidation work"
```

Reference clones are **per-repo**, declared in that repo's
`.qmd/references.yml` and built into `ref-<repo>`. They are NOT searched by a
bare `aqmd "question"` — run `aqmd research` explicitly. An agent that searches
its own repo, finds nothing, and concludes an idea is unexplored would be wrong
if the prior-art clones were never consulted.

Before designing something non-obvious, check whether it has already been solved
here.

The shared policy index is a **rebuildable snapshot**, so it lags the per-repo
indexes. For anything in the repo you are standing in, plain `aqmd "question"`
is both faster and current.

### If the repo has no index

`aqmd` will tell you, and print the command. Build one:

```bash
DEV=<parent-of-the-repo> /Volumes/ThunderBolt/Development/_ob/bin/qmd-backfill
```

Resumable, skips repos that already have a valid index, and repairs a repo whose
config was lost. Do not fall back to grepping the whole tree and calling the
repo unsearchable.

Never run `qmd collection add`, `qmd collection remove`, or `qmd init` in a repo
that already has `.qmd/` — the config is generated from an allowlist (below) and
hand-adding a collection silently reintroduces the vendored trees it exists to
exclude.

### `.qmd/index.yml` is tracked. Keep it that way.

The database is gitignored and rebuildable. The **config is committed**, because
it is the expensive artifact — the allowlist of which directories hold this
repo's real source. An untracked config has no recovery path: nothing restores
it and nothing notices it is gone. That is exactly how one repo lost its scoping
and silently ran the whole repo set for four GPU-minutes before anyone noticed.

If you see `.qmd/index.yml` deleted or modified in `git status`, that is a real
change. Do not discard it without looking.

## Two ways in, and when each is right

**Raw SQL for keyword and structure.** Faster (~0.015s), and needs nothing but
`sqlite3` — no qmd install, works from any script or box.

```bash
# Keyword search, best matches first. BM25 scores are NEGATIVE: closer to zero
# is a worse match, so ORDER BY ascending puts the best hit on top.
sqlite3 .qmd/index.sqlite "
SELECT round(bm25(documents_fts),2), d.path
FROM documents_fts f JOIN documents d ON d.id = f.rowid
WHERE documents_fts MATCH 'body:caddy'
ORDER BY bm25(documents_fts) LIMIT 10;"

# Everything under a path prefix
sqlite3 .qmd/index.sqlite \
  "SELECT path FROM documents WHERE active=1 AND path LIKE 'scripts/%';"

# How much of this repo is indexed
sqlite3 .qmd/index.sqlite "SELECT count(*) FROM documents WHERE active=1;"
```

Scope `MATCH` to `body:` unless you mean to search filenames and titles too —
an unscoped `MATCH 'caddy'` also hits every path containing the word, which
buries the real content matches.

**`aqmd` for semantic.** When you do not know the vocabulary the code uses —
"how does deployment get rolled back", not "rollback" — SQL cannot help. FTS5
matches words; only the embeddings reach meaning.

```bash
aqmd "how does the reverse proxy get deployed"   # semantic + rerank
qmd search "caddy"                               # BM25, same as the SQL
qmd get "#abc123"                                # fetch by docid
```

Rule of thumb: **you know the word → SQL. You know the idea → `aqmd`.**

## Use the fast tools, not the walking ones

`grep`, `find`, and `ls -R` walk the filesystem. Their replacements query an
index or are an order of magnitude faster, and all of them are installed. This
is not style preference — it is the difference between a sub-second answer and
one that takes long enough to discourage checking at all, which is how agents
end up guessing instead of looking.

| Want | Use | Not |
|---|---|---|
| Content in this repo | `rg` | `grep` |
| File by name in this repo | `fd` | `find .` |
| File anywhere on the disk | `mdfind` | `find /` |
| "How does X work" here | `aqmd "..."` | reading files at random |
| "How does X work" in another repo | `aqmd -r <repo> "..."` | `cd` there and back |
| "How does X work" in several repos | `aqmd -r a,b "..."` | one query per repo by hand |
| "What is the rule / standard for X" | `aqmd internal "..."` | asking the operator |
| Refresh after writing files | `aqmd up` | `qmd update; qmd embed` |
| Read a known file | Read tool / `bat` | `cat` into context |

`mdfind` is the one people forget. It reads the Spotlight index rather than
walking directories: measured **0.41s across the entire disk** against **6.7s
for `fd` scoped to one project**. Reach for it when you do not already know
which repo owns a file.

`fd` and `rg` are gitignore-aware by default, so they skip `node_modules`,
`.venv`, and build output without being told. Pass `-HI` (`fd`) or
`-uu` (`rg`) when you genuinely need ignored files.

Keep `bash` for real multi-step work — pipes, post-processing, anything a
single-purpose tool cannot express. The rule is about not walking a filesystem
by hand, not about avoiding shells.

## What the index does not cover

The allowlist admits source and docs, not build output, virtual envs, vendored
trees, or databases. Much of what looks missing is correctly excluded — check
with `rg --files` before assuming the index is wrong.

If something genuinely belongs and is missing, the fix is the repo's allowlist,
not a broader mask. See `_ob/etc/qmd-index-overrides.yml` for how deliberately
gitignored source trees get named back in.

## GOTCHA: a file can be present, committed, and still unfindable

Two independent defects hid real files, both measured 2026-07-30. Neither
produced an error. In both cases the index reported success while the content
was unreachable, which is the worst failure shape a search tool has — you get a
confident empty result and conclude the thing does not exist.

**1. The allowlist is a snapshot, and `aqmd up` does not refresh it.**

`.qmd/index.yml` lists directory patterns generated when the repo was first
indexed. `aqmd up` indexes files *against those existing patterns*; it does not
create new ones. So a repo that gains a **new top-level directory** after its
first index never gets a pattern for it, and every file underneath is invisible
forever.

Receipt: `rtech-consulting` had 140 tracked markdown files under a renamed
`pocs/kits/` that no query could reach. They were committed, tracked, and on
disk. Regenerating took the repo from 200 to 359 indexed documents and added 73
pattern lines.

The trap is that `aqmd up` reports success — it correctly indexed everything the
patterns describe. The patterns were the problem.

    # Fix: rebuild the allowlist. REGEN is required because backfill SKIPS any
    # repo that already has a valid index.yml (resumable-by-design).
    REGEN=1 DEV=/Volumes/ThunderBolt/Development ONLY_REPO=<repo> \
      _ob/bin/qmd-backfill
    aqmd up

Do NOT delete `.qmd/index.yml` to force a rebuild. That was the only route
before `REGEN` existed and it is a bad procedure: the config is committed, and
"delete it and trust the rebuild" fails badly across a repo set this size.

**2. Untracked files used to be structurally invisible. Fixed — verify the fix
is present before trusting it.**

`qmd-backfill` built the allowlist from `git ls-files`, so a directory earned a
pattern only once something in it was **committed**. Uncommitted notes could not
be indexed at all — worst exactly when you need search most, while still
writing.

Fixed 2026-07-30 by enumerating with `fd` (gitignore-aware, sees untracked
work). Verified: a brand-new uncommitted file in `_reports/` was embedded and
semantically retrievable while still showing `??` in `git status`.

Repo-set impact before the fix: ~1,400 untracked markdown files unindexed, and 46
of 53 repos could not search their own synced `_DOCS/STANDARDS-*.md`, because
those files are written by sync and never committed. The rules were on disk and
invisible to the tool agents use to find rules.

    # Confirm your qmd-backfill has the fix:
    rg -c 'fd -t f' _ob/bin/qmd-backfill    # 1 = fixed; 0 = still git ls-files

### Diagnosing "I know this file exists but search cannot find it"

In order, stopping at the first that explains it:

    # 1. Is it on disk and indexable at all?
    rg --files | rg <name>

    # 2. Is it in the index?
    sqlite3 .qmd/index.sqlite \
      "SELECT path FROM documents WHERE active=1 AND path LIKE '%<name>%';"

    # 3. Does the allowlist even have a pattern for its directory?
    rg '<its-directory>' .qmd/index.yml     # no output = defect 1 above

    # 4. Is it deliberately excluded? (lockfiles, *.min.js, .qmd/, secrets)
    rg -A40 'ignore:' .qmd/index.yml

A file that passes 1, fails 2, and fails 3 is defect 1 — regenerate with
`REGEN=1`. Empty output at step 4 with a legitimate file is a real gap; fix the
repo's allowlist rather than widening the mask.
