# Issue 1417 paired recall receipt

This directory preserves the reviewed harness and compact receipts from runner job `ob-1417-paired-same-index-0918g`. The run compared base `6ecd002aa6ee86a55c44f103d5e4805a1481f7df` with current `4eb1810316c68b711df9b6cbeec68c50db73f2ee` against one restored database and 24 fixtures.

The retained comparison reports `PASS`: no base PASS became a current miss, vector rows and scores matched, namespace and isolation controls passed, the two target ranks were 2 and 4, model calls were zero, and database and role teardown were verified. This is a paired recall receipt only. It does not prove held-out recall, DREAM behavior, deployment readiness, or complete release acceptance.

## Provenance and custody

The complete runner output remains external at:

`/srv/shared/runners/jobs/ob-1417-paired-same-index-0918g/runner-1/out/`

The full `base.json` and `current.json` traces, raw logs, install logs, database logs, and agent logs are deliberately excluded from Git. This package is therefore not self-contained. Replaying the comparison requires the two external JSON traces.

The JavaScript harness files are immutable historical evidence, not installed repository source. They retain their original bytes under inert archival names so repository tooling does not treat their pre-existing style as maintained code:

| Original runner filename | Retained filename | SHA-256 |
| --- | --- | --- |
| `ab-trace-driver-v2.mjs` | `ab-trace-driver-v2.mjs.txt` | `cb579ef0afae3a9c5df4cd7659c4a3b36519bf8842bfeb957d43ae4f066ed39a` |
| `trace-evidence-reader.mjs` | `trace-evidence-reader.mjs.txt` | `d01e0faeb1739d53cae95335ca6f0b7ec7f261de7c92b3a306304b63c4bb2ae8` |
| `compare-base-current.mjs` | `compare-base-current.mjs.txt` | `31e05b39721e2e62b162d051891c5c307dcc4df6046ccad83e12bdfbadda97e7` |

No executable repository code references the inert copies. `final-artifacts.sha256` is the runner's original external manifest; its `/work/out/...` names describe the runner filesystem. `custody.sha256` is the local manifest for files actually retained here.

## Offline replay

Reconstruct the original comparator filename in approved scratch, verify its pinned hash, then compare the retained expected result with the external full traces:

```sh
RUNNER_OUT=/srv/shared/runners/jobs/ob-1417-paired-same-index-0918g/runner-1/out
REPLAY=/srv/_tmp/open-brain/_scratch/issue-1417-paired-0918g-replay
mkdir -p "$REPLAY"
cp compare-base-current.mjs.txt "$REPLAY/compare-base-current.mjs"
printf '%s  %s\n' 31e05b39721e2e62b162d051891c5c307dcc4df6046ccad83e12bdfbadda97e7 "$REPLAY/compare-base-current.mjs" | shasum -a 256 -c -
node --input-type=module -e 'import {readFileSync} from "node:fs"; const [modulePath,basePath,currentPath,pinsPath,expectedPath]=process.argv.slice(2); const {compare}=await import("file://"+modulePath); const actual=compare(JSON.parse(readFileSync(basePath)),JSON.parse(readFileSync(currentPath)),JSON.parse(readFileSync(pinsPath))); const expected=JSON.parse(readFileSync(expectedPath)); if (JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error("offline replay differs from retained comparison"); console.log(`OFFLINE_CHECK_PASS status=${actual.status} cases=${actual.cases.length}`);' dummy "$REPLAY/compare-base-current.mjs" "$RUNNER_OUT/base.json" "$RUNNER_OUT/current.json" "$PWD/paired-pins.json" "$PWD/paired-comparison.json"
```

The comparator's standalone CLI entry point contains historical fixed input hashes. This paired run intentionally imports `compare()` and supplies `paired-pins.json`, matching the executed harness.

## Bookkeeping limitation

The local scribe was enabled when this receipt was recovered, but `rodaddy/open-brain` was not configured for the Forgejo backend and issue 1417 was parked after repeated delivery failures. No scribe event or GitHub fallback was emitted; repository evidence is the durable receipt.
