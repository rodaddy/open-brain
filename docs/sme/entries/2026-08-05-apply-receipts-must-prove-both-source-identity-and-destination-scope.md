---
lane: gotcha-agent
order: 33
section: harvest-522
---
## [2026-08-05] Apply receipts must prove both source identity and destination scope

**Severity:** HIGH
**Source:** issue #588, first live canon reconcile apply after PR #538
**Scope key:** `canon.apply_receipt_proves_source_and_namespace`
**Status:** active

### Pattern

Two false assumptions can make an apply path report success while producing no
usable state. First, a human provenance field is not a machine source pointer:
repo-fact `source` prose was copied into `metadata.path`, while the server
requires that path to equal the GitHub URL's repo-relative path exactly. The
owning entrypoint must carry the pack artifact path separately and preserve the
human citation in a prose provenance field.

Second, a client's requested identity is not evidence of the namespace the
server authorized. An admin-token fan-out reported 27 applied writes for
`skippy`, but the write receipts identified token authority and the rows landed
under `admin`. An apply command must inspect the returned receipt for the actual
namespace authority. PR #594's opposite-family review found that the server's
`writer_identity` is that authority on both token and delegated-header paths;
`delegated_agent_id` is an independent agent label and cannot prove destination.
If the receipt has no usable namespace signal, perform one scoped read-back and
verify the expected keys and texts before printing success. That read-back must
request every planned lane and carry the exact repo binding for repo facts, or a
configuration gap can be mislabeled as a namespace incident.

A duplicate receipt is also not a new write. Count it as already present and
report it separately, so a retry cannot turn prior state into an applied count.

### Review Questions

- Does any field serve as both human citation prose and a machine-exact path,
  identifier, or URL component? Split those meanings at the owning boundary.
- Does a write receipt prove where the row landed, or only that the request
  returned without an error?
- When client configuration requests another identity, does the server honor it
  under this token role, and does the receipt expose which authority won?
- Is namespace validation based on the server's persisted writer identity rather
  than an independent agent label or the caller's requested identity?
- Are duplicate receipts reported as already present instead of newly applied?
- If a receipt cannot identify the destination, does the apply path read back
  the exact expected keys and values before claiming success?
- Can that read-back observe every planned lane under the exact repo binding, or
  will a configuration gap be reported as a namespace mismatch?
