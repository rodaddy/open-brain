import { mkdtempSync } from "node:fs";
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
});
