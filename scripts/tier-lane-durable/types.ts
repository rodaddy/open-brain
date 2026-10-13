// Shared shapes for the lane → own-durable tiering runner (issue #160). Split
// out of the entrypoint at issue 864 L6; the field names and the on-disk state
// and receipt formats are unchanged.

export interface Cursor {
  created_at?: string;
  id?: string;
}

export interface State {
  version: 1;
  cursors: Record<string, Cursor>;
  last_receipt?: Receipt;
}

export interface NamespaceReceipt {
  scanned: number;
  graduated: number;
  would_graduate: number;
  kept: number;
  archived: number;
  manual_review: number;
  duplicates: number;
  failed: number;
}

export interface Receipt {
  started_at: string;
  finished_at: string;
  dry_run: boolean;
  scanned: number;
  graduated: number;
  would_graduate: number;
  kept: number;
  archived: number;
  manual_review: number;
  duplicates: number;
  failed: number;
  namespaces: Record<string, NamespaceReceipt>;
  failures: Array<{ namespace: string; id: string; error: string }>;
}

export interface Args {
  apply: boolean;
  stateFile: string;
  batchSize: number;
  maxApply: number;
  delayMs: number;
  loop: boolean;
  intervalMs: number;
  minContentLength: number;
  dupThreshold: number;
}
