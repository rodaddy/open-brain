import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { RecoveryWalStore } from "./recovery-wal.ts";

const SCOPE = {
  namespace: "rico",
  agent: "nagatha",
  platform: "discord",
  server_id: "rodaddy-live",
  channel_id: "open-brain",
  thread_id: null,
  session_key: "session-221",
};

function appendOnlyWalRecord(
  scope: typeof SCOPE,
  id: string,
  content: string,
  updatedAt: string,
  options: {
    metadata?: Record<string, unknown>;
    expiresAt?: string;
  } = {},
): string {
  return `${JSON.stringify({
    op: "append",
    scope,
    item: {
      id,
      label: "quarantined_recovery",
      status: "active",
      content,
      trace_id: null,
      source_ref: null,
      metadata: options.metadata ?? {},
      created_at: updatedAt,
      updated_at: updatedAt,
      expires_at: options.expiresAt ?? "2099-01-01T00:00:00.000Z",
      reviewed_at: null,
      last_action: null,
    },
  })}\n`;
}

describe("RecoveryWalStore", () => {
  it("persists exact-scope pending recovery across restart from WAL", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    const store = new RecoveryWalStore({ walPath });

    const appended = store.append(SCOPE, {
      content: "Interrupted trace that needs review",
      trace_id: "trace-221",
    });

    expect(appended.accepted).toBe(true);

    const restarted = new RecoveryWalStore({ walPath });
    const fragment = restarted.buildContextPackFragment(SCOPE);

    expect(fragment.recovery).toMatchObject({
      label: "quarantined_recovery",
      exact_scope_required: true,
      not_durable_memory: true,
      not_searchable_recall: true,
      unreviewed_quarantine: true,
      pending_count: 1,
      wal_path_configured: true,
    });
    expect(fragment.recovery.items[0]).toMatchObject({
      content_preview: "Interrupted trace that needs review",
      trace_id: "trace-221",
      status: "active",
    });
  });

  it("does not expose adjacent-scope recovery and reports a scope denial", () => {
    const store = new RecoveryWalStore();
    store.append(SCOPE, { content: "base recovery" });
    store.append(
      {
        ...SCOPE,
        channel_id: "other-channel",
      },
      { content: "adjacent recovery" },
    );

    const fragment = store.buildContextPackFragment(SCOPE);

    expect(fragment.recovery.items.map((item) => item.content_preview)).toEqual([
      "base recovery",
    ]);
    expect(fragment.warnings.scope_denials).toHaveLength(1);
    const [denial] = fragment.warnings.scope_denials;
    expect(denial?.reasons).toContain("channel_id");
  });

  it("marks reviewed recovery out of pending context and can purge it", () => {
    const store = new RecoveryWalStore();
    const appended = store.append(SCOPE, { content: "review me" });
    const id = appended.item!.id;

    const marked = store.mark(SCOPE, id, "review", "reviewed");
    expect(marked.accepted).toBe(true);
    expect(store.buildContextPackFragment(SCOPE).recovery.pending_count).toBe(0);

    const purged = store.mark(SCOPE, id, "discard", "discarded", {
      purge: true,
    });
    expect(purged.accepted).toBe(true);
    expect(purged.purged).toBe(true);
  });

  it("keeps reviewed marks out of pending context after WAL replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    const store = new RecoveryWalStore({ walPath });
    const appended = store.append(SCOPE, { content: "review and restart" });
    const id = appended.item!.id;
    store.mark(SCOPE, id, "review", "reviewed");

    const restarted = new RecoveryWalStore({ walPath });

    expect(restarted.buildContextPackFragment(SCOPE).recovery.pending_count).toBe(0);
  });

  it("keeps per-session trims absent after WAL replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    const store = new RecoveryWalStore({
      walPath,
      budget: { max_items_per_session: 1 },
    });

    store.append(SCOPE, { content: "trimmed old" });
    store.append(SCOPE, { content: "kept new" });

    const restarted = new RecoveryWalStore({
      walPath,
      budget: { max_items_per_session: 1 },
    });
    const fragment = restarted.buildContextPackFragment(SCOPE);

    expect(fragment.recovery.items.map((item) => item.content_preview)).toEqual([
      "kept new",
    ]);
  });

  it("keeps session-count trims absent after WAL replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    const store = new RecoveryWalStore({
      walPath,
      budget: { max_sessions: 1 },
    });

    store.append(SCOPE, { content: "trimmed session" });
    store.append(
      { ...SCOPE, session_key: "session-222" },
      { content: "kept session" },
    );

    const restarted = new RecoveryWalStore({
      walPath,
      budget: { max_sessions: 1 },
    });

    expect(restarted.buildContextPackFragment(SCOPE).recovery.pending_count).toBe(0);
    expect(
      restarted.buildContextPackFragment({ ...SCOPE, session_key: "session-222" })
        .recovery.items[0]?.content_preview,
    ).toBe("kept session");
  });

  it("keeps global-item trims absent after WAL replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    const store = new RecoveryWalStore({
      walPath,
      budget: { max_global_items: 1 },
    });

    store.append(SCOPE, { content: "trimmed global" });
    store.append(
      { ...SCOPE, session_key: "session-222" },
      { content: "kept global" },
    );

    const restarted = new RecoveryWalStore({
      walPath,
      budget: { max_global_items: 1 },
    });

    expect(restarted.buildContextPackFragment(SCOPE).recovery.pending_count).toBe(0);
    expect(
      restarted.buildContextPackFragment({ ...SCOPE, session_key: "session-222" })
        .recovery.items[0]?.content_preview,
    ).toBe("kept global");
  });

  it("enforces per-session budgets when replaying append-only WAL rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    appendFileSync(
      walPath,
      appendOnlyWalRecord(SCOPE, "rw-1", "old append-only", "2026-07-06T01:00:00.000Z"),
      "utf8",
    );
    appendFileSync(
      walPath,
      appendOnlyWalRecord(SCOPE, "rw-2", "kept append-only", "2026-07-06T02:00:00.000Z"),
      "utf8",
    );

    const restarted = new RecoveryWalStore({
      walPath,
      budget: { max_items_per_session: 1 },
    });

    expect(restarted.buildContextPackFragment(SCOPE).recovery.items).toMatchObject([
      { id: "rw-2", content_preview: "kept append-only" },
    ]);
  });

  it("enforces global item budgets when replaying append-only WAL rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    appendFileSync(
      walPath,
      appendOnlyWalRecord(SCOPE, "rw-1", "old global append", "2026-07-06T01:00:00.000Z"),
      "utf8",
    );
    appendFileSync(
      walPath,
      appendOnlyWalRecord(
        { ...SCOPE, session_key: "session-222" },
        "rw-2",
        "kept global append",
        "2026-07-06T02:00:00.000Z",
      ),
      "utf8",
    );

    const restarted = new RecoveryWalStore({
      walPath,
      budget: { max_global_items: 1 },
    });

    expect(restarted.buildContextPackFragment(SCOPE).recovery.pending_count).toBe(0);
    expect(
      restarted.buildContextPackFragment({ ...SCOPE, session_key: "session-222" })
        .recovery.items[0]?.content_preview,
    ).toBe("kept global append");
  });

  it("enforces session budgets when replaying append-only WAL rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    appendFileSync(
      walPath,
      appendOnlyWalRecord(SCOPE, "rw-1", "old session append", "2026-07-06T01:00:00.000Z"),
      "utf8",
    );
    appendFileSync(
      walPath,
      appendOnlyWalRecord(
        { ...SCOPE, session_key: "session-222" },
        "rw-2",
        "kept session append",
        "2026-07-06T02:00:00.000Z",
      ),
      "utf8",
    );

    const restarted = new RecoveryWalStore({
      walPath,
      budget: { max_sessions: 1 },
    });

    expect(restarted.buildContextPackFragment(SCOPE).recovery.pending_count).toBe(0);
    expect(
      restarted.buildContextPackFragment({ ...SCOPE, session_key: "session-222" })
        .recovery.items[0]?.content_preview,
    ).toBe("kept session append");
  });

  it("compacts append-only WAL rows after replay budget enforcement", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    appendFileSync(
      walPath,
      appendOnlyWalRecord(SCOPE, "rw-1", "old compact append", "2026-07-06T01:00:00.000Z"),
      "utf8",
    );
    appendFileSync(
      walPath,
      appendOnlyWalRecord(SCOPE, "rw-2", "kept compact append", "2026-07-06T02:00:00.000Z"),
      "utf8",
    );

    new RecoveryWalStore({ walPath, budget: { max_items_per_session: 1 } });

    const compactedRows = readFileSync(walPath, "utf8").trim().split("\n");
    expect(compactedRows).toHaveLength(1);
    expect(compactedRows[0]).toContain("kept compact append");
  });

  it("skips oversized replay rows before exposing recovery context", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    appendFileSync(
      walPath,
      appendOnlyWalRecord(SCOPE, "rw-1", "content-too-large", "2026-07-06T01:00:00.000Z"),
      "utf8",
    );
    appendFileSync(
      walPath,
      appendOnlyWalRecord(
        SCOPE,
        "rw-2",
        "ok",
        "2026-07-06T02:00:00.000Z",
        { metadata: { big: "metadata-too-large" } },
      ),
      "utf8",
    );

    const restarted = new RecoveryWalStore({
      walPath,
      budget: { max_content_chars: 10, max_metadata_chars: 10 },
    });

    expect(restarted.buildContextPackFragment(SCOPE).recovery.pending_count).toBe(0);
    expect(restarted.getCounters().dropped).toBe(2);
  });

  it("does not write WAL rows while reading expired recovery context", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    const store = new RecoveryWalStore({ walPath });
    store.append(
      SCOPE,
      { content: "expired read-only recovery" },
      new Date("2026-07-06T01:00:00.000Z"),
    );
    const rowsBefore = readFileSync(walPath, "utf8").trim().split("\n");

    const fragment = store.buildContextPackFragment(
      SCOPE,
      new Date("2026-07-08T01:00:00.000Z"),
    );
    const rowsAfter = readFileSync(walPath, "utf8").trim().split("\n");

    expect(fragment.recovery.pending_count).toBe(0);
    expect(rowsAfter).toEqual(rowsBefore);
  });

  it("skips malformed JSONL records without crashing restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-recovery-wal-"));
    const walPath = join(dir, "recovery.jsonl");
    const store = new RecoveryWalStore({ walPath });
    store.append(SCOPE, { content: "valid recovery" });
    appendFileSync(walPath, '{"op":"append"}\n', "utf8");
    appendFileSync(
      walPath,
      `${JSON.stringify({
        op: "mark",
        scope: SCOPE,
        id: "rw-1",
        action: "review",
        status: "reviewed",
        reviewed_at: null,
        updated_at: "not-a-date",
      })}\n`,
      "utf8",
    );
    appendFileSync(
      walPath,
      `${JSON.stringify({
        op: "mark",
        scope: SCOPE,
        id: "rw-1",
        action: "review",
        status: "reviewed",
        reviewed_at: "not-a-date",
        updated_at: "2026-07-06T03:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const restarted = new RecoveryWalStore({ walPath });

    expect(restarted.buildContextPackFragment(SCOPE).recovery.pending_count).toBe(1);
  });
});
