---
lane: correctness
order: 37
---
## [2026-07-23] Snapshot validation and derived writes must share one locked transaction

**Severity:** HIGH (P1)
**Source:** PR #358 opposite-runtime terminal audit (issue #346)
**Scope:** `src/graph-derivation-handler.ts`, multi-statement maintenance derivations
**Status:** fixed-pre-merge

### Pattern

The graph handler validated a source snapshot, then stamped the final derivation
hash and wrote nodes, links, and stale-edge pruning in independent statements.
A later transient failure could leave the completed hash with an incomplete graph;
a retry then returned `unchanged` and never repaired it. The same gap let an old
job pass its snapshot check, pause, and overwrite a newer derivation after the
source advanced.

### Rule

Lock and revalidate the authoritative source row with `SELECT ... FOR UPDATE`,
then run the entire derived write set on the same checked-out client and in the
same transaction. Commit the source proof, final hash, nodes, links, and pruning
as one unit; rollback all of them on any error. This serializes source updates
with derivation so an old job either finishes before the source advances or sees
drift and terminal-stops after the newer revision commits.

### Review Questions

- Can a final hash/status stamp commit before any later derived write or prune?
- Do snapshot validation and every derived mutation use one transaction/client?
- Is the source row locked so concurrent source updates cannot invalidate the
  snapshot between validation and commit?
- Does a real-PostgreSQL fault-injection test prove a mid-derivation failure leaves
  no partial hash, nodes, or links and that retry converges?
- Does a deterministic old/new interleaving test prove the newer snapshot remains
  final and an obsolete job cannot overwrite it?
