// Node worker thread that reads a qmd index file off the event loop: returns
// the newest of the index and WAL mtimes plus the active document and
// collection counts, so a stale index can be reported instead of passing.
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

interface QmdIndexProbeRequest {
  path: string;
}

export interface QmdIndexProbeResult {
  modified_at_ms: number;
  document_count: number;
  collection_count: number;
}

if (!parentPort) throw new Error("qmd_index_probe_requires_worker_parent");
const port = parentPort;

port.on("message", (request: QmdIndexProbeRequest) => {
  const indexModifiedAtMs = statSync(request.path).mtimeMs;
  // qmd uses WAL mode: new writes advance index.sqlite-wal while index.sqlite
  // keeps the last checkpoint mtime. The newest file is the actual freshness.
  const walModifiedAtMs =
    statSync(`${request.path}-wal`, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const database = new DatabaseSync(request.path, { readOnly: true });
  try {
    const documentRow = database
      .prepare("SELECT COUNT(*) AS count FROM documents WHERE active = 1")
      .get() as { count: number };
    const collectionRow = database
      .prepare("SELECT COUNT(*) AS count FROM store_collections")
      .get() as { count: number };
    port.postMessage({
      modified_at_ms: Math.max(indexModifiedAtMs, walModifiedAtMs),
      document_count: Number(documentRow.count),
      collection_count: Number(collectionRow.count),
    });
  } finally {
    database.close();
  }
});
