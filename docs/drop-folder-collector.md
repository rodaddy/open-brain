# Drop-Folder Collector (`collect_drop_folder`)

Ingests files placed under a registered, approved, active **`drop`** source's
folder through Open Brain's shared metadata + durable capture path. The server
discovers and reads the files itself; callers select the approved source and
never submit file bodies or paths.

Issue: #339 (SOURCE-3). Parent: #336.

## What the caller supplies

```jsonc
{
  "external_id": "quarterly-drops",        // the registered drop source's locator
  "target_namespace": "team-alpha",        // optional; defaults to your own namespace
  "tags": ["drop"]                          // optional content-free tags for every row
}
```

There is **no** file-body, path, or root input. The folder root is derived
server-side from the durable source registry.

## Eligibility and trust boundary

Before any file is read or any row is written, the collector gates on two
server-side checks, in order:

1. **Registry eligibility** — reuses the `#337` ingestion gate
   (`resolveIngestionEligibility`). The exact registry entry for this
   namespace + `drop` kind + `external_id` must be **approved** and in the
   **active** lifecycle state. A caller-asserted approval flag never reaches
   this path. Unregistered → `not_found`; registered-but-not-approved or
   not-active → `approval_denied`.
2. **Write authority** — `canWriteNamespace` is enforced against the **exact**
   target namespace. Eligibility only proves the caller may *read* the source;
   a read-authorized but write-unauthorized caller is denied here with **zero
   file reads and zero durable writes**. Examples that are denied:
   - `readonly`/`agent` into `shared-kb` (not a promoter identity),
   - any role into a frozen namespace such as `collab`,
   - a header-scoped identity targeting a namespace other than its header.

   Denial code: `namespace_denied`.

The folder root comes **only** from the durable source record's
`config.root` (an absolute path). A source with no configured root →
`no_root`; a configured root that does not resolve to a real directory →
`root_unavailable`. The caller can never influence the root.

## Root confinement (traversal + symlink escape)

The configured root is resolved to its real path once (`realpath`). During
discovery, every candidate entry is resolved to its real path and must stay
under the real root; otherwise it is silently excluded (never read). This single
check rejects both `..` traversal and symlink escape, for files and directories
alike:

- A symlink whose target is **outside** the root is not followed.
- A symlinked **directory** escaping the root is not descended.
- A configured root that is itself a symlink to a real directory **is** honored
  (its real target is used), and files under that real directory ingest.

Only files with a supported text extension are read: `.txt`, `.md`,
`.markdown`, `.text`, `.log`, `.json`, `.yaml`, `.yml`, `.csv`. Anything else is
not discovered as ingestible.

## Bounds

All bounds are server-side and clamped to safe positive integers; there is no
caller-supplied way to raise them. Defaults (env override in parentheses):

| Bound | Default | Env |
|-------|---------|-----|
| Max files read | 256 | `DROP_COLLECTOR_MAX_FILES` |
| Max bytes per file | 1 MiB | `DROP_COLLECTOR_MAX_FILE_BYTES` |
| Max total bytes | 16 MiB | `DROP_COLLECTOR_MAX_TOTAL_BYTES` |
| Max directory depth | 8 | `DROP_COLLECTOR_MAX_DEPTH` |

A file over the per-file cap is skipped (`too_large`) — never partially read.
Discovery stops after bounded filesystem-order iteration when either the file
candidate limit or inspected-entry limit is reached. Only the retained bounded
set is sorted for processing; omitted tail entries are not enumerated and do
not produce per-file receipts. The aggregate result reports `truncated: true`.
Once the next retained file would exceed the total-byte cap, that file and the
remaining retained files are reported as `total_bound`.

## Identity, dedupe, and idempotence

File identity is the **same normalized content hash** the durable log tools use
(lowercase + trim + whitespace-collapse). The receipt hash, the in-batch dedupe
key, and the durable `(content_hash, namespace)` upsert therefore all agree:

- Two files whose bodies differ only by case or whitespace collapse to **one**
  durable row; the other is reported `deduped`.
- Repeats within one folder (e.g. `[A, B, A]`) collect `A` once, `B` once, and
  dedupe the second `A` — the full observed hash set is tracked, not just the
  last hash.
- A **rerun** of an unchanged folder is a full no-op: every file dedupes at the
  durable row, no redundant embedding or write happens, and the source's
  observed `content_hash` (a deterministic manifest digest of the collected file
  hashes) is not re-stamped.

New/changed content is written durably and enriched with extracted metadata in
the background exactly as a logged thought would be.

## Partial failure

A single unreadable or over-cap retained file does not fail the whole
collection: it produces a truthful per-file `skipped` receipt and the rest
proceed. Discovery count/scan truncation is reported only by the aggregate
`truncated` flag because omitted tail entries are never materialized. If the
post-ingest source content-hash stamp drifts (concurrent update,
retirement, revocation), the already-landed durable rows are unaffected and the
stamp outcome is logged content-free.

## Content-free receipts and logs

Every receipt, log line, and error is content-free. Receipts carry:

- a stable **opaque file token** (a digest of the file's root-relative path —
  never the path itself),
- an opaque normalized **content hash** and byte length (when the file was
  read),
- the durable row id and a `durable_merged` flag (when collected),
- structural counts (`collected`, `deduped`, `skipped`, `truncated`) and stable
  status/reason codes.

No file body, absolute or relative path, `external_id` echoed from a failure, or
driver message ever leaves the server — including on an unexpected internal
error, which maps to a fixed `internal_error` envelope.

## Result shape

```jsonc
// eligible + ingested
{
  "ok": true,
  "eligible": true,
  "namespace": "team-alpha",
  "collected": 2,
  "deduped": 1,
  "skipped": 0,
  "truncated": false,
  "files": [
    { "status": "collected", "file_token": "…", "content_hash": "…",
      "byte_length": 512, "durable_id": "…", "durable_merged": false }
    // …
  ]
}

// rejected before any read
{ "ok": false, "eligible": false, "code": "namespace_denied" }
```

## Scope

Intentionally narrow. This collector reads the registry, discovers files once,
ingests them, and stamps the source's observed content hash. It is **not**
`#338` reconciliation, `#340` conversation ingestion, or a scheduler, and it
never changes source-registry authority. Registering and approving a `drop`
source (including setting `config.root`) is done through the source-registry
tools, not here.
