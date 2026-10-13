// Shapes shared by the lane→shared-kb promoter modules (issue #161, split at
// issue 864 L6 so each module stays under the file-size rule; behaviour is
// unchanged and the entrypoint still re-exports the public surface).

/** Promotable own-durable tables that promoteEntry handles directly. */
export const PROMOTE_TABLES = ["thoughts", "decisions"] as const;
export type PromoteTable = (typeof PROMOTE_TABLES)[number];
export type Source = PromoteTable | "ob_session_events";

export interface Cursor {
  created_at?: string;
  id?: string;
}

export interface State {
  version: 1;
  target_namespace: string;
  cursors: Partial<Record<Source, Cursor>>;
  last_receipt?: Receipt;
}

export interface SourceReceipt {
  scanned: number;
  shared: number;
  would_share: number;
  rejected_secret: number;
  rejected_private: number;
  rejected_noise: number;
  manual_review: number;
  duplicates: number;
  failed: number;
  /** New shared thoughts linked into an existing cluster (apply only, #173). */
  clustered: number;
}

export interface Receipt {
  started_at: string;
  finished_at: string;
  dry_run: boolean;
  target_namespace: string;
  scanned: number;
  shared: number;
  would_share: number;
  rejected_secret: number;
  rejected_private: number;
  rejected_noise: number;
  manual_review: number;
  duplicates: number;
  failed: number;
  clustered: number;
  sources: Partial<Record<Source, SourceReceipt>>;
  failures: Array<{ source: Source; id: string; error: string }>;
}

export interface Args {
  apply: boolean;
  targetNamespace: string;
  stateFile: string;
  batchSize: number;
  maxApply: number;
  delayMs: number;
  loop: boolean;
  intervalMs: number;
  minContentLength: number;
}

export interface NominatedRow {
  id: string;
  created_at: string;
  content: string;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
}

export interface NominatedEventRow {
  id: string;
  created_at: string;
  content: string;
  content_hash: string | null;
  event_type: string;
  importance: string;
  metadata: Record<string, unknown> | null;
  lane_id: string;
  namespace: string;
  agent: string | null;
  session_key: string;
  repo: string | null;
  project: string | null;
}
