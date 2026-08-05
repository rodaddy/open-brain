import { statSync } from "node:fs";
import { Database } from "bun:sqlite";

interface QmdIndexProbeRequest {
  path: string;
}

export interface QmdIndexProbeResult {
  modified_at_ms: number;
  document_count: number;
  collection_count: number;
}

interface QmdIndexWorkerGlobal {
  onmessage: ((event: MessageEvent<QmdIndexProbeRequest>) => void) | null;
  postMessage(message: QmdIndexProbeResult): void;
}

const workerGlobal = globalThis as unknown as QmdIndexWorkerGlobal;
workerGlobal.onmessage = (event) => {
  const indexModifiedAtMs = statSync(event.data.path).mtimeMs;
  // qmd uses WAL mode: new writes advance index.sqlite-wal while index.sqlite
  // keeps the last checkpoint mtime. The newest file is the actual freshness.
  const walModifiedAtMs =
    statSync(`${event.data.path}-wal`, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const database = new Database(event.data.path, { readonly: true });
  try {
    const documentRow = database
      .query("SELECT COUNT(*) AS count FROM documents WHERE active = 1")
      .get() as { count: number };
    const collectionRow = database
      .query("SELECT COUNT(*) AS count FROM store_collections")
      .get() as { count: number };
    workerGlobal.postMessage({
      modified_at_ms: Math.max(indexModifiedAtMs, walModifiedAtMs),
      document_count: Number(documentRow.count),
      collection_count: Number(collectionRow.count),
    });
  } finally {
    database.close();
  }
};
