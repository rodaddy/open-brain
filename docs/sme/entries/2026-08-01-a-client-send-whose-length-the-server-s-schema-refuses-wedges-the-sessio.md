---
lane: correctness
order: 47
---
## [2026-08-01] A client send whose length the server's schema refuses wedges the session forever

**Severity:** HIGH
**Source:** PR #455 adversarial lane, fixed on `rewrite/420-settings-cutover`
**Scope:** `python/openbrain/src/openbrain/apps/capture/deliver.py`, any client
path that hands a variable-length array to a server whose Zod schema validates
its length
**Status:** active

### Pattern

`deliver_new_turns` built one payload from EVERY unread turn and sent it in a
single `ingest_raw_turn` call. The server's request schema validates the
`turns` array length (`MAX_BATCH = 100`, `src/tools/ingest-raw-turn.ts`) and
refuses the whole call above it before writing a row. A single live transcript
held 234 operator turns; a first Stop, or any read that resumes from offset 0
after a file replacement, produces more than one call carries. The refusal
raised, the watermark advanced only after a returning call, so the same region
re-read and re-failed on every subsequent Stop — a permanently wedged session,
every new turn silently lost, the exact failure the rewrite exists to end.

The in-process recorder tests were green because a fake that never crossed 100
accepts what the real server refuses (the #275 fake-vs-real gap). The fix sends
in successive full calls the server accepts, advancing the watermark only after
the whole delivery returns; a mid-delivery failure re-reads the region and the
server's `UNIQUE(namespace, turn_uuid)` dedupe makes the already-landed calls a
no-op. Nothing is dropped and nothing is stored twice.

### Review Questions

- When a client hands a server a variable-length array, does a test drive MORE
  than the server's own schema accepts in one call, through a fake that enforces
  the same length rule the server does — or only small fixtures?
- Does the fake used in a green test reject what the real server rejects? If it
  cannot fail on the oversized input, it is not proving the path.
- On a send failure, does the watermark (or any resume cursor) stay put so the
  region re-reads, and is the re-send idempotent on the server's dedupe key?
