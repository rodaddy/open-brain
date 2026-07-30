# Consolidation: stop writing the same thing four times

**Status:** PROPOSED. Nothing below is built.
**Measured:** 2026-07-30, against `src/` (142 non-test files, 50,452 lines),
`python/openbrain-memory/`, and the installed provider adapter.

## Why

Four separate layers each implement "reject input over 64 KB", with three
different behaviours. Removing it in one layer fixed nothing end to end:

| layer | file | behaviour |
|---|---|---|
| provider adapter | `ob-memory-provider.ts:146` -> `:1912` | `return null` — **silent**, exit 0, no receipt |
| Python CLI | `cli.py:23` | `raise ValueError` — whole write lost |
| Python validation | `_runtime_validation.py` | per-field rejection |
| TS server | assorted | varies by tool |

Proven live 2026-07-30: a 101 KB `capture` through the documented provider
path produced **no receipt and exit code 0**. A 200-byte capture through the
same path returned `{"status":"saved","durable":true}`. The large one was
discarded silently.

This is not one bug. It is the predictable outcome of having no shared
definition of anything.

## The census

| duplication | count |
|---|---|
| independent content-bound definitions (`MAX_*_BYTES/CHARS/LEN`) | **36** across 25+ files |
| files hand-writing hash -> embed -> INSERT(embedding, content_hash, embedded_at, embedding_model) | **18** |
| layers re-implementing the 64 KB admission rule | **4** |
| shared entry-write abstraction | **0** |
| TS files with no logger import | **48 of 142** |
| named typed contracts (`Protocol`/ABC) — Python | **10** |
| named typed contracts — TypeScript | **0** |

`aqmd "is there a shared write path or repository layer for entries"` returns
nothing describing one. **UNVERIFIED — no such design exists.** Each caller
was written standalone.

## What is already good (do not rebuild)

- **TS strictness is not the problem.** `tsconfig.json` already sets
  `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`. Two gaps only:
  `noUnusedLocals: false` and `noUnusedParameters: false`.
- **Python is the model to copy.** `disallow_untyped_defs = true`, and 10
  `Protocol` classes (`MemoryClient`, `Transport`, `DirectClient`,
  `MaintenanceHandler`, `MemorySpool`, ...) that define a contract once and
  let implementations vary behind it.
- `src/chunking.ts`, `parent_id`/`chunk_index`, `renderExchangeParts`,
  `describeError()`, the `logger` itself — all correct, all under-used.

The defect is not missing quality. It is missing REUSE.

## The delta

### 1. One admission definition

A single module stating what may be accepted, imported by every layer
including the provider adapter. No layer restates a size. Where a bound is
structural (a pipe read, a datatype), it is named once, documented with what
it is and whose it is, and never silently applied.

### 2. One entry-write path

The 18 hand-written sequences become callers of one typed writer that:
hashes, embeds (segmenting long text via `generateEmbeddingWithMetadata`),
writes parent + chunk rows, handles conflict, and logs entry/exit/failure.

Fixing chunking or embedding then happens once. Today `log_thought` chunks
and `rest-api.ts` does not, purely because there was nothing shared to change.

### 3. Typed contracts, mirroring the Python

TS interfaces for the boundaries that currently have none — the entry writer,
the embedder, the transport. Named, documented, one implementation each.

### 4. Logger established once, inherited

Constructed at application start with service context, passed down rather
than re-imported per file. Closes the 48 files that log nothing today.

Also flip `noUnusedLocals`/`noUnusedParameters` to `true`: a dead variable in
`distiller.ts` this session only surfaced as a hard compile error, and would
otherwise have shipped.

## Order

1. **Adapter silent drop** — actively losing captures right now. Fix first,
   end to end, and prove it with a >64 KB capture returning a real receipt.
2. **Admission definition** — one source, all four layers.
3. **Entry-write path** — migrate the 18 call sites incrementally, each with
   its behaviour pinned by a test before it moves.
4. **Contracts + logger** — as each boundary is touched, not as a big-bang.

## Standing rule this encodes

Reuse what is known good. Do not rewrite it. A second implementation of an
existing rule is a defect on sight, even when it is correct today — because
the next fix will reach one copy and not the others, which is exactly how a
101 KB capture came to vanish without an error.
