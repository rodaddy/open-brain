---
lane: gotcha-agent
order: 20
---
## [2026-07-25] uv ANSI output disabled Open Brain session-start recall

**Severity:** HIGH
**Source:** live incident — post-compact recall failure, dogfood Open Brain
**Scope:** `ob-memory-provider/package-runtime.ts` uv resolution
**Status:** open — fix belongs in the adapter source repo, not the hash-pinned
install

> The general rules this produced (force machine-readable subprocess output,
> misdirecting errors cost more than silence, instrument rather than infer,
> never hand-patch a hash-pinned install, gates must not block their own
> repair) are now in `_DOCS/CODING_STANDARDS.md` `## Gotchas` and apply
> fleet-wide. This entry keeps only the Open Brain specifics.

Session-start recall failed with `OB ✗ gate unavailable` while BOTH Open Brain
servers were healthy (127.0.0.1:3100 and 10.71.1.21:3100 each returned 200),
Postgres was reachable, the token authenticated, the env config was correct, and
the `openbrain-memory` CLI at 0.1.18 returned a full valid context pack
(`status: "direct"`, 14,663 chars) when invoked directly with the same payload.

Root cause: `uv` emitted ANSI color codes on stdout. `commandPath()` runs
`uv tool dir`, then `isAbsolute(stdout.trim())`. The actual bytes were
`033 [ 3 6 m / U s e r s / ...` (proven with `od -c`), which is not an absolute
path, so `commandPath` returned null -> `resolveUvToolLayout` null ->
`resolvePackageRuntime` null -> `callPackage` returned
`{ok: false, errorCategory: "provider"}` **before any network call was made**.
The adapter then reported "lane memory unavailable", naming the network as the
suspect for a local string-parsing failure.

The fix is a subprocess-scoped `env: {...process.env, NO_COLOR: "1"}` on the
`spawnSync` in `defaultPackageRuntimeRunner`, plus ANSI stripping before
`isAbsolute()`. Do NOT set `NO_COLOR` in the operator's shell environment —
Rico uses color interactively; the adapter owns its child env, not the session.
Do NOT hand-patch the installed `sha256-<hash>` adapter directory: the hash is
the version pin, and the next `uv tool install --upgrade` silently erases the
patch, guaranteeing rediscovery of a bug already "fixed".

**Cost of the suppression:** four layers each computed the cause and discarded
it — `commandPath` knew the `isAbsolute` check failed, `resolveUvToolLayout`
knew the layout was unresolved, `resolvePackageRuntime` knew it returned null,
and `callPackage` computed `errorCategory: "provider"` then shipped it to
Langfuse instead of stdout. This violates `_DOCS/CODING_STANDARDS.md`
`## Observability` verbatim: *"Catch blocks that return a fallback value must log
before returning. Never `catch { return null }` silently."* One `console.error`
at the resolution site would have made this a two-minute fix; instead it cost
~40 minutes and three wrong diagnoses (missing env key, wrong base URL, version
mismatch), each disproved only by an operator-run command.

**The diagnostic method that actually worked**, after reading code failed three
times: copy the module beside its own imports (relative imports break if moved),
insert `console.error` at every failure branch, run it. Do not infer a runtime
cause from code structure when the error text is suppressed — instrument it.
Reading cannot see a runtime value.

**A wrong error message is more expensive than no error message.** Silence makes
you look; misdirection makes you look elsewhere. "Unavailable" sent six probes
against two healthy servers.

### Review Questions

- Does any code path parse another program's stdout? If so, does it force
  machine-readable output (`NO_COLOR`, `--format json`, `--quiet`) in the
  subprocess env AND sanitize before parsing? A convenience CLI's formatting is
  not a stable contract; it changes on the tool's schedule, not yours.
- Is that env forcing scoped to the child process, or does it leak into the
  operator's interactive shell?
- Does every `return null` / `return {ok: false}` on a failure path log the
  specific reason first, or does the caller receive an undifferentiated null?
- When a failure category IS computed (e.g. `errorCategory`), does the operator
  see it, or is it exported to telemetry only? Telemetry is not a substitute for
  an error message at the terminal.
- Does one generic failure string cover multiple distinct causes that require
  different operator actions (config invalid vs server unreachable vs validation
  failed)? Name each cause distinctly.
- Does the error message name the subsystem that actually failed? A local
  parsing failure reported as a remote availability problem routes the responder
  to the wrong half of the system.
- Can a gate that depends on a subsystem block the repair of that same
  subsystem? A context/policy gate needs a repair-mode escape or it deadlocks
  exactly when it is needed most.
