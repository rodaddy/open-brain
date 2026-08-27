# Graph Mode v1.3-beta — executables

Status: WRITTEN 2026-08-27. Opt-in per repo, never spun out by `setup`
unless Rico names the beta for that repo. Prose and opt-in steps:
`_DOCS/GRAPH_MODE_SOP-v1.3-beta.md`. Ratified protocol these sit beside:
`_DOCS/GRAPH_MODE_SOP.md` v1.1.

Every directory is self-contained: an entrypoint, `README.md`, `fixtures/`
with passing and failing inputs, and `RED.md` with the real transcript of
the check failing before it passed. Exit grammar is the fleet one, `0`
pass / `1` the thing under test failed / `3` harness error; examining
nothing is `3`, never `0`.

| dir | entrypoint | proves |
|---|---|---|
| `lane-report/` | `check.sh <report>` | the five-field lane report parses: field set and order, no empty values, nothing after `lessons:`, claim states in the truth grammar, a `verified:` line carrying `exit N` |
| `ratchet-bound/` | `check.sh <lane-contract.md> [--bound N]` | live Tightenings at or under the bound, every entry with `provenance:`, `graduated:` entries not counted; entries are `- **YYYY-MM-DD` bullets or `### YYYY-MM-DD` blocks, and a section with content but no recognised entry is exit 3 |
| `placeholders/` | `check.sh <file>... [--allow <tok>]` | no unresolved scaffold token in an instantiated RUN artifact (run README, dispatch plan, ledger). Not for standing contracts, which use `<path>`-style notation in prose |
| `decisions/` | `check.sh <decisions.md> [--repo] [--diff-base] [--section]` and `templates/decisions.md` | the nine-column ledger has no conflicting live rulings, no ruling without falsifier or rejected options, no dangling `Supersedes`, and no `Retires` without a done-means change in the diff |
| `brief-pack/` | `pack.sh --task --lane-contract --done-means [...]` | a lane brief assembled by ranked inclusion with an explicit excluded list, refused over budget rather than truncated |
| `loop-policy/` | `check.sh <dispatch-plan.md>`, `snippet.js`, `templates/` | a dispatch plan carries a complete loop policy with a mandatory non-retry `on_exhaust`; the snippet evaluates guards in priority order under an injected clock and budget |

Shell entrypoints are bash 3.2 clean for the cc-* boxes. The three that
need TypeScript (`lane-report`, `brief-pack`, `decisions`) resolve Node in
this order and exit 3 if none: `$NODE_BIN`, `/opt/homebrew/opt/node@24/bin/node`,
`node` on PATH. No dependencies, no package.json; LSP will report missing
`@types/node` in these files and that is the known cost of staying
dependency-free here.

Run everything at once from this directory:

```
for d in lane-report ratchet-bound placeholders decisions loop-policy; do \
  (cd "$d" && for f in fixtures/*; do ./check.sh "$f" >/dev/null 2>&1; \
  echo "$d $f -> exit $?"; done); done
```

Nothing here is wired to a hook, merge gate, or CI. The controller runs
these by hand at the landing points the SOP names; promotion up the
enforcement ladder is a per-repo ruling after the pilot.
