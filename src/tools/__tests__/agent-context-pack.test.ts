import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";

describe("agent_context_pack and working_set_append", () => {
  it("round-trips RAM-only working context through exact-scope context pack", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "current_intent",
          content: "Finish #222 without deploying core01.",
          trace_id: "trace-222",
        },
      });

      expect(append.isError).toBeFalsy();
      const appendPayload = JSON.parse((append.content as any)[0].text);
      expect(appendPayload).toMatchObject({
        accepted: true,
        not_durable_memory: true,
      });
      expect(appendPayload.item).toMatchObject({
        kind: "current_intent",
        label: "working_context",
      });

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
        },
      });

      expect(pack.isError).toBeFalsy();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload).toMatchObject({
        schema: "openbrain.agent_context_pack.v1",
        status: "ok",
      });
      expect(payload.sections.working_set).toMatchObject({
        label: "working_context",
        exact_scope_required: true,
        not_durable_memory: true,
        item_count: 1,
      });
      expect(payload.sections.working_set.items[0]).toMatchObject({
        content: "Finish #222 without deploying core01.",
        label: "working_context",
        trace_id: "trace-222",
      });
      expect(payload.warnings.scope_denials).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("does not include adjacent-scope working context and reports scope denial", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "task_state",
          content: "base task",
        },
      });
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          channel_id: "adjacent-channel",
          kind: "task_state",
          content: "adjacent task",
        },
      });

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.working_set.items.map((item: any) => item.content)).toEqual([
        "base task",
      ]);
      expect(payload.warnings.scope_denials).toHaveLength(1);
      expect(payload.warnings.scope_denials[0].reasons).toContain("channel_id");
    } finally {
      await cleanup();
    }
  });

  it("does not include threaded working context in unthreaded scope and reports thread_id denial", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "task_state",
          content: "base task",
        },
      });
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          thread_id: "adjacent-thread",
          kind: "task_state",
          content: "threaded task",
        },
      });

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.working_set.items.map((item: any) => item.content)).toEqual([
        "base task",
      ]);
      expect(payload.warnings.scope_denials).toHaveLength(1);
      expect(payload.warnings.scope_denials[0].reasons).toContain("thread_id");
    } finally {
      await cleanup();
    }
  });

  it("does not disclose foreign-namespace working-set denials", async () => {
    const adminAuth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(adminAuth);

    try {
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "task_state",
          content: "base task",
        },
      });
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          namespace: "kevin",
          kind: "task_state",
          content: "foreign task",
        },
      });

      const viewer = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
        },
      });

      const payload = JSON.parse((viewer.content as any)[0].text);
      expect(payload.sections.working_set.items.map((item: any) => item.content)).toEqual([
        "base task",
      ]);
      expect(payload.warnings.scope_denials).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("rejects oversized metadata before retaining RAM context", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "current_intent",
          content: "valid content",
          metadata: { large: "x".repeat(3000) },
        },
      });

      expect(append.isError).toBe(true);
      const payload = JSON.parse((append.content as any)[0].text);
      expect(payload).toMatchObject({
        accepted: false,
        reason: "metadata_too_large",
      });
    } finally {
      await cleanup();
    }
  });

  it("rejects RAM working-set writes for readonly auth", async () => {
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          namespace: "viewer",
          kind: "current_intent",
          content: "readonly should fail",
        },
      });

      expect(append.isError).toBe(true);
      expect((append.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("returns recovery only through explicit unreviewed quarantine request", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "recovery_wal_append",
        arguments: {
          ...SCOPE,
          content: "Recovered interrupted trace",
          trace_id: "trace-221",
        },
      });

      expect(append.isError).toBeFalsy();
      const appendPayload = JSON.parse((append.content as any)[0].text);
      expect(appendPayload).toMatchObject({
        accepted: true,
        not_durable_memory: true,
        not_searchable_recall: true,
        unreviewed_quarantine: true,
      });

      const hidden = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["recovery"],
        },
      });
      const hiddenPayload = JSON.parse((hidden.content as any)[0].text);
      expect(hiddenPayload.sections.recovery).toBeUndefined();

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["recovery"],
          include_unreviewed_recovery: true,
        },
      });

      expect(pack.isError).toBeFalsy();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.recovery).toMatchObject({
        label: "quarantined_recovery",
        exact_scope_required: true,
        not_durable_memory: true,
        not_searchable_recall: true,
        unreviewed_quarantine: true,
        pending_count: 1,
      });
      expect(payload.sections.recovery.items[0]).toMatchObject({
        content_preview: "Recovered interrupted trace",
        trace_id: "trace-221",
        status: "active",
      });
    } finally {
      await cleanup();
    }
  });

  it("marks recovery reviewed so it leaves pending context", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "recovery_wal_append",
        arguments: {
          ...SCOPE,
          content: "Recovered interrupted trace",
        },
      });
      const id = JSON.parse((append.content as any)[0].text).item.id;

      const mark = await client.callTool({
        name: "recovery_wal_mark",
        arguments: {
          ...SCOPE,
          id,
          action: "review",
          status: "reviewed",
        },
      });

      expect(mark.isError).toBeFalsy();
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["recovery"],
          include_unreviewed_recovery: true,
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.recovery.pending_count).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
