# TypeScript Standards

How TypeScript in this repo set is typed, logged, validated, and enforced.

**Status: WRITTEN, and thinner than its Python counterpart.** This document is
the TypeScript section lifted out of `CODING_STANDARDS.md` on 2026-07-30, where
it had grown to 32 lines wedged between unrelated material. It has not yet been
rebuilt from a worked example the way `STANDARDS-python.md` was, and there is no
`_DOCS/typescript-exemplar/` yet. Treat the rules below as authoritative and the
coverage as incomplete — the structure, config, testing, and enforcement
sections a full standard needs are not here.

`king-capital/docs/coding-standards.md` is the proven source for the
observability rules; repo-local standards may be stricter but must not weaken
them.

---

## Toolchain

- Prefer `bun` for package and script workflows.
- Keep code strict-friendly.

## Typing

- Avoid implicit `any`, unnecessary explicit `any`, and non-null assertions.
- Type weakly-contextual callbacks and public data shapes.
- Prefer schema validation for external/untrusted data (Zod `.safeParse()`,
  returning structured errors rather than throwing).
- `catch (error: unknown)` — narrow before use. Never `catch (e: any)` and never
  `error as Error`.

## Control flow

Rico's rules, 2026-07-30. The language-agnostic statement is in
`CODING_STANDARDS.md ## Control Flow`; this section owns the TypeScript
spelling. `STANDARDS-python.md` states the same rules for Python — they are
deliberately duplicated per language, because a TypeScript-only repo never
receives the Python bundle and a rule that reaches half the repo set is not a
standard.

**NEVER nest conditionals.** An `if` inside an `if` is a hard anti-pattern.
Each level multiplies the paths through a function; three levels of two-way
branching is eight paths, nobody writes eight tests, so most ship unexercised.

**NEVER write a long `if`/`else if` chain.** Complexity rises with every case,
and each new one means re-reading the ladder to find where it belongs.

**PREFER a union type plus a lookup table over conditionals.** A stack of
sequential `if`s is not the destination — it is nesting laid on its side, still
one branch per line to read and test. Turn the rules into data:

```ts
// NO -- grows a branch per case, and nothing checks that every case is handled
if (event.kind === "push") return handlePush(event);
else if (event.kind === "tag") return handleTag(event);
else if (event.kind === "release") return handleRelease(event);
// ... eight more

// YES -- a Record keyed by the union. Adding a case is one row, complexity
// stays constant, and the table is assertable in a test without calling the
// consumer. `Record<EventKind, ...>` makes a MISSING case a compile error,
// which an if/else chain can never do.
type EventKind = "push" | "tag" | "release";

const HANDLERS: Record<EventKind, (e: Event) => void> = {
  push: handlePush,
  tag: handleTag,
  release: handleRelease,
};

const handler = HANDLERS[event.kind];
if (!handler) throw new UnknownEventError(event.kind);
handler(event);
```

**Use a string-literal union, not a TypeScript `enum`.** This is where
TypeScript differs from Python, and the difference is worth stating: Python's
`StrEnum` is the right tool there, but TS `enum` emits a runtime object, does
not narrow structurally, and `const enum` breaks under `isolatedModules`. A
union of string literals gives the same exhaustiveness checking with no runtime
cost. `as const` objects work where you need iterable values.

**Exhaustiveness is a compile-time guarantee — use it.** The main advantage
over Python here:

```ts
function describe(kind: EventKind): string {
  switch (kind) {
    case "push":    return "code pushed";
    case "tag":     return "tag created";
    case "release": return "release published";
    default: {
      // Adding a member to EventKind makes THIS line fail to compile, naming
      // the case nobody handled. An if/else chain fails silently at runtime.
      const unreachable: never = kind;
      throw new Error(`unhandled event kind: ${String(unreachable)}`);
    }
  }
}
```

Order of preference: union + lookup table, then `switch` with a `never` default
when each case returns a different computed value, then guard clauses for two
or three genuinely unrelated checks, then extracting a function. Plain nested
conditionals are not on the list.

**Enforcement.** These are the rule names to configure; this document does not
claim they are currently active in any given repo — verify in the repo's own
lint config before calling them enforced:

- `complexity` (max ~10) — total branch count per function
- `max-depth` (max 3) — the nesting rule; counts all block types, so allow room
  for a legitimate `try`/`for`/`with`-style nesting that contains no branching
- `no-else-return` — the usual cause of accidental nesting
- `@typescript-eslint/switch-exhaustiveness-check` — enforces the `never`
  default above rather than relying on the author to write it

## Logging and observability

Implements `CODING_STANDARDS.md` `## Observability (non-negotiable, all
languages)`, which owns the rules. This is the TypeScript spelling.

- **Pino only. Never `console.log`/`warn`/`error`** outside the logging module
  itself.
- One preconfigured `logger` export per service. No logger assembly at call
  sites.
- Bind per-operation context with child loggers (`rootLogger.child({ service })`)
  rather than repeating fields at every call.
- Carry `correlation_id` across `await` boundaries with `AsyncLocalStorage`. A
  correlation id that has to be threaded by hand will be dropped somewhere.
- Never spread a raw error object into a log entry; it can carry attached
  request, credential, or payload data.

## Configuration

Configuration in one module, schema-validated at boot, exiting on invalid input.
Do not scatter `process.env` reads through the codebase.

This is the same keystone rule as `STANDARDS-python.md` `## config.py — the
keystone`: one module owns configuration, validates it at startup, and hands it
down. Everything that document says about fail-fast messages and dependency
injection applies here, in TypeScript spelling.

## Documentation

Public functions and modules documented with TSDoc (`@param`, `@returns`,
`@throws`) at the same bar as Google-style docstrings in Python.

## `catch {}` is the TypeScript `except: pass`

A bound-but-unlogged `catch (e) {}` is the same violation as an empty block.
When auditing, count both — an empty-block linter alone reports a repo as clean
while most of its catch sites still discard the error.

Reading logging and error handling as Python-only rules is what produced roughly
1,100 bare `catch {}` blocks across the repo set while CI stayed green.

Highest risk is a swallowed error in the diagnostic and durability paths — log
sinks, health checks, WAL recovery — where silence removes the only evidence you
would have had.

---

## What this document still needs

Named so the gap is visible rather than assumed covered:

- A worked example at `_DOCS/typescript-exemplar/`, the way Python has one.
- Repo layout and file-size rules.
- Test conventions (runner, async patterns, mocking).
- A commit-time enforcement table naming what blocks a commit, and hooks wired
  through `_githooks/` with per-repo `core.hooksPath`.
- **A verified lint config for `## Control flow`.** That section names the rules
  (`complexity`, `max-depth`, `no-else-return`,
  `switch-exhaustiveness-check`) but no repo has been confirmed to have them
  enabled, and no linter is pinned repo-set-wide for TypeScript the way `ruff` is
  for Python. Until that exists the control-flow rules are reviewed by humans,
  not enforced — say so rather than implying a gate that does not fire.

Until those exist, `STANDARDS-python.md` `## Enforcement` is the model to copy;
the mechanism lesson there is language-independent.
