# Open Brain

MCP server providing a unified semantic brain over PostgreSQL + pgvector.

Full documentation lives in [`docs/README.md`](docs/README.md), alongside
[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md),
[`docs/GLOSSARY.md`](docs/GLOSSARY.md), and
[`docs/LEARNINGS.md`](docs/LEARNINGS.md).

## Grading candidates (the review page, #394)

The distiller writes proposals to `candidate_memory`; nothing in that table is
durable memory until a human grades it. This page is where that happens.

```bash
# Load the database credentials for the local dogfood clone.
set -a; . /Volumes/ThunderBolt/open-brain-local/local-clone.env; set +a

bun scripts/grading-server-run.ts
```

It prints the URL and the size of the queue, then serves on
**http://127.0.0.1:3417/**. Open that in a browser.

| Flag | Env | Default | What it does |
|---|---|---|---|
| `--port` | `GRADING_PORT` | `3417` | Listen port. |
| `--namespace` | `OB_GRADING_NAMESPACE` | `rico` | Which namespace's candidates to grade. Every read and write is scoped to it. |
| `--graded-by` | `GRADED_BY` | `rico` | Who is grading. Written to `candidate_memory.graded_by`. |

The host is **not** configurable: the server binds `127.0.0.1` only, and that
loopback boundary is what stands in for a token (see the header of
`src/grading-server.ts`).

### Grading, from the keyboard

One candidate at a time, with its source turns and the surrounding
conversation. No mouse needed.

| Key | Action |
|---|---|
| <kbd>1</kbd> | **pass** — `promoted` |
| <kbd>2</kbd> | **fail** — `rejected` |
| <kbd>3</kbd> | **inconclusive** — "I cannot tell", which is *not* a rejection |
| <kbd>4</kbd> | **duplicate** |
| <kbd>u</kbd> | undo the last grade (puts it back in the queue) |
| <kbd>←</kbd> <kbd>→</kbd> | move between items without grading |
| <kbd>n</kbd> | focus the note field (<kbd>Esc</kbd> to leave it) |

The card advances only after a grade is confirmed written. When the queue is
empty, the page offers the *"grade all those inconclusive things"* pass over
everything marked <kbd>3</kbd>.

The header shows progress, the per-action tally, and the running
**machine agreement rate** — how often REM's `machine_grade` matched the human
`review_action`. That number is the point of keeping the two columns separate
(`src/db/migrations/037_candidate_memory_uncertainty.sql:88-94`); nothing on
this page can write `machine_grade`, and the API rejects a request that tries.

### Endpoints

`GET /` (page) · `GET /api/queue` · `GET /api/inconclusive` · `GET /api/stats` ·
`POST /api/grade` · `POST /api/ungrade` · `GET /health`
