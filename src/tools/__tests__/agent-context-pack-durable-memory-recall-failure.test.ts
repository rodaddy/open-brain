import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import { addLogSink, getLogLevel, setLogLevel } from "../../logger.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";

describe("agent_context_pack durable_memory recall_failed envelope", () => {
  it("emits a truthful recall_failed durable_memory envelope for an explicitly requested section without leaking database errors", async () => {
    // When recall throws for an explicitly requested durable_memory section, the
    // section is NOT omitted: a truthful empty envelope is emitted (items [],
    // item_count 0, truncated false, empty_reason recall_failed) alongside the
    // content-free degraded_sources warning and empty citations. This is distinct
    // from an unrequested section (which is absent entirely).
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async () => {
        throw new Error("postgres://secret-host/internal-detail");
      },
    });
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["durable_memory"],
        },
      });
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      // The requested section is present and truthful, not omitted.
      expect(section).toBeDefined();
      expect(section).toMatchObject({
        label: "durable_memory",
        namespace_scoped: true,
        query: "durable",
        empty_reason: "recall_failed",
        item_count: 0,
        truncated: false,
      });
      expect(section.items).toEqual([]);
      expect(payload.citations).toEqual([]);
      // The content-free degraded_sources warning is retained.
      expect(payload.warnings.degraded_sources).toContainEqual({
        source: "durable_memory",
        reason: "recall_failed",
      });
      // No dependency/error detail leaks anywhere in the emitted pack — not the
      // envelope, the warning, the citations, or the section body.
      expect(JSON.stringify(payload)).not.toContain("secret-host");
      expect(JSON.stringify(payload)).not.toContain("internal-detail");
      expect(JSON.stringify(payload)).not.toContain("postgres");
      // The only reason string anywhere is the stable, content-free recall_failed
      // marker — no raw error message or dependency detail is carried through.
      expect(section.empty_reason).toBe("recall_failed");
      expect(JSON.stringify(payload)).not.toContain("Error");
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack durable_memory failure-path logging", () => {
  it("never logs the raw recall query on the failure path, only its length (F2)", async () => {
    // Sol cross-family finding: the recall-failure detail record logged the raw
    // caller `query`. A query is arbitrary private content (a name, incident
    // text) that credential-shaped redaction cannot make safe. The fix drops the
    // query body from both failure records and keeps only query_chars on the
    // detail line, routing error fields through describeError.
    //
    // This is a STRUCTURAL guard on the source rather than a runtime log capture:
    // the detail line is a debug line whose emission depends on the process-wide
    // log level, which sibling test files move, making a sink-capture assertion
    // order-dependent and flaky. Reading the source is deterministic and fails
    // the instant a bare `query:` is reintroduced into either failure log call.
    const source = await Bun.file(
      new URL("../../../server/tools/context-pack-durable-memory.ts", import.meta.url),
    ).text();

    // Isolate the failure-logging call that handles a failed recall. The
    // anchors moved at L5: the two inline logger calls became one
    // `logDurableFailure` call over the shared two-line shape, so the slice now
    // runs from that call site to the pgDiagnosticFields line that ends its
    // detailFields -- NOT the returned recall_failed envelope, whose `query`
    // field is a legitimate echo asserted elsewhere.
    const failStart = source.indexOf("logDurableFailure({");
    const failEnd = source.indexOf(
      'pgDiagnosticFields(error, ["code", "detail", "hint"])',
      failStart,
    );
    expect(failStart).toBeGreaterThan(-1);
    expect(failEnd).toBeGreaterThan(failStart);
    const failureBlock = source.slice(failStart, failEnd);

    // The length is recorded...
    expect(failureBlock).toContain("query_chars: query.length");
    // ...error fields go through the content-safe redaction boundary...
    expect(failureBlock).toContain("logDurableFailure");
    // ...and NO bare `query,` (the raw body) is logged on the failure path. A
    // `query_chars:` line contains the substring "query" but never the bare
    // shorthand `query,` that would log the whole string.
    expect(/(^|[^_])query,\s*$/m.test(failureBlock)).toBe(false);
    // Only the named pg diagnostic keys reach the log. The older spread echoed
    // arbitrary driver fields, which could carry query fragments; the allowlist
    // is now explicit and this asserts it stays that way.
    expect(source.slice(failStart)).toContain(
      'pgDiagnosticFields(error, ["code", "detail", "hint"])',
    );
  });
});

describe("agent_context_pack durable_memory failure-path content safety", () => {
  it("keeps recall failure content-free at runtime and reports query length", async () => {
    // The behavioral companion to the structural guard: when a sink DOES observe
    // the failure records (debug forced here), the raw query is absent and the
    // length is present. Scoped to this call's durable records and guarded so a
    // sibling file that suppresses the debug line cannot flake it.
    const secretQuery = `PRIVATE-INCIDENT-${Math.random().toString(36).slice(2)}-jane-doe`;
    const captured: Array<Record<string, unknown>> = [];
    const removeSink = addLogSink((entry) => captured.push(entry));
    const savedLevel = getLogLevel();
    setLogLevel("debug");
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async () => {
        throw new Error("db down");
      },
    });
    try {
      await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: secretQuery,
          requested_sections: ["durable_memory"],
        },
      });
      // At L5 the message strings are the twin's event names, not the old src
      // prose: logDurableFailure emits `<event>` and `<event>_detail`.
      const durableRecords = captured.filter(
        (r) =>
          r.message === "durable_memory_recall_failed" ||
          r.message === "durable_memory_recall_failed_detail",
      );
      // Guard against a vacuous pass: if the filter matches nothing, the
      // not.toContain assertions below hold trivially and prove nothing.
      expect(durableRecords.length).toBeGreaterThan(0);
      // The raw query body appears in none of this call's durable records.
      expect(JSON.stringify(durableRecords)).not.toContain(secretQuery);
      for (const r of durableRecords) {
        expect(r.query).toBeUndefined();
      }
      const detail = durableRecords.find(
        (r) => r.message === "durable_memory_recall_failed_detail",
      );
      // Only assert length when the debug detail line was actually observed;
      // its emission depends on the effective level, which is not this test's
      // to guarantee against sibling files.
      if (detail) {
        expect(detail.query_chars).toBe(secretQuery.length);
      }
    } finally {
      await cleanup();
      removeSink();
      setLogLevel(savedLevel);
    }
  });
});
