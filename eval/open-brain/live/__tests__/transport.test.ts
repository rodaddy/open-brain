import { describe, expect, it } from "bun:test";
import {
  OpenBrainLiveClient,
  LiveTransportError,
  createMcpCaller,
  isDenialLabel,
  parseHits,
  redactToolFailure,
  sanitizeThrownTransportError,
  type McpClientLike,
  type OpenBrainToolCaller,
  type ToolCallResult,
} from "../transport.ts";

// Behavior tests for the live transport wrapper. These target the redaction
// boundary and the semantic client without touching a hosted server: every
// failure must be reduced to a content-free label, denial must be modeled
// distinctly from a generic error, and the primary recall path must never
// swallow a denial (only the explicit isolation probe may).

/** A scripted fake caller: each tool name maps to a queue of results. */
function fakeCaller(
  script: Record<string, ToolCallResult[]>,
  log?: { calls: Array<{ name: string; args: Record<string, unknown> }> },
): OpenBrainToolCaller {
  const queues: Record<string, ToolCallResult[]> = {};
  for (const [k, v] of Object.entries(script)) queues[k] = [...v];
  return {
    async callTool(name, args) {
      log?.calls.push({ name, args });
      const q = queues[name];
      if (!q || q.length === 0) {
        throw new Error(`fake caller has no scripted result for ${name}`);
      }
      return q.shift()!;
    },
    async close() {},
  };
}

function ok(data: string): ToolCallResult {
  return { isError: false, denied: false, data, errorLabel: "" };
}
function denied(label: string): ToolCallResult {
  return { isError: true, denied: true, data: "", errorLabel: label };
}
function errored(label: string): ToolCallResult {
  return { isError: true, denied: false, data: "", errorLabel: label };
}

describe("redactToolFailure (content-free error boundary)", () => {
  it("emits a tool:reason label and never the raw body", () => {
    const secretBody =
      "Permission denied: cannot read namespace 'x' SECRET-TOKEN-abc123 memory body here";
    const { errorLabel, denied: isDenied } = redactToolFailure(
      "search_brain",
      secretBody,
    );
    expect(errorLabel).toBe("search_brain:permission-denied");
    expect(isDenied).toBe(true);
    // The label must not carry any of the sensitive substrings.
    expect(errorLabel).not.toContain("SECRET-TOKEN");
    expect(errorLabel).not.toContain("memory body");
    expect(errorLabel).not.toContain("namespace 'x'");
  });

  it("collapses an unknown error body to a bare tool:error label", () => {
    const { errorLabel, denied: isDenied } = redactToolFailure(
      "log_thought",
      "Row 4831 content: my private grommet torque note leaked here",
    );
    expect(errorLabel).toBe("log_thought:error");
    expect(isDenied).toBe(false);
    expect(errorLabel).not.toContain("grommet");
    expect(errorLabel).not.toContain("4831");
  });

  it("recognizes denial labels", () => {
    expect(isDenialLabel("search_brain:permission-denied")).toBe(true);
    expect(isDenialLabel("archive_entry:forbidden")).toBe(true);
    expect(isDenialLabel("search_brain:not-found")).toBe(false);
    expect(isDenialLabel("log_thought:error")).toBe(false);
  });

  it("prioritizes a denial keyword over a generic one in a mixed body", () => {
    // A body that mixes "invalid" with "unauthorized" must classify as a denial:
    // the generic keyword appears first lexically, but denial precedence wins so
    // the isolation proof / auth failure is never misread as a plain error.
    const mixed = redactToolFailure(
      "search_brain",
      "Invalid request: unauthorized for namespace 'neg'",
    );
    expect(mixed.errorLabel).toBe("search_brain:unauthorized");
    expect(mixed.denied).toBe(true);

    const mixed2 = redactToolFailure(
      "archive_entry",
      "invalid archive: forbidden for this namespace",
    );
    expect(mixed2.errorLabel).toBe("archive_entry:forbidden");
    expect(mixed2.denied).toBe(true);

    // "permission denied" also wins over a leading "invalid".
    const mixed3 = redactToolFailure(
      "search_brain",
      "invalid: permission denied reading namespace",
    );
    expect(mixed3.errorLabel).toBe("search_brain:permission-denied");
    expect(mixed3.denied).toBe(true);
  });

  it("keeps a generic label when no denial keyword is present", () => {
    const generic = redactToolFailure("log_thought", "invalid payload shape");
    expect(generic.errorLabel).toBe("log_thought:invalid");
    expect(generic.denied).toBe(false);
  });

  it("sanitizeThrownTransportError prioritizes a mixed-body denial keyword", () => {
    const err = sanitizeThrownTransportError(
      "connect",
      new Error("HTTP 400 invalid request: forbidden token for namespace"),
    );
    // Denial keyword wins over both "invalid" and the status code.
    expect(err.label).toBe("connect:forbidden");
    expect(err.denied).toBe(true);
  });
});

describe("OpenBrainLiveClient.logMemory", () => {
  it("returns the server id + namespace on success", async () => {
    const log = {
      calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    };
    const client = new OpenBrainLiveClient(
      fakeCaller(
        {
          log_thought: [ok(JSON.stringify({ id: "srv-1", namespace: "ns-a" }))],
        },
        log,
      ),
    );
    const res = await client.logMemory({
      table: "thoughts",
      content: "c",
      tags: [],
      namespace: "ns-a",
    });
    expect(res).toEqual({ id: "srv-1", namespace: "ns-a" });
    expect(log.calls[0]?.args.namespace).toBe("ns-a");
  });

  it("throws a redacted LiveTransportError on failure (no raw body)", async () => {
    const client = new OpenBrainLiveClient(
      fakeCaller({ log_decision: [errored("log_decision:error")] }),
    );
    await expect(
      client.logMemory({
        table: "decisions",
        content: "c",
        tags: [],
        namespace: "n",
      }),
    ).rejects.toThrow(LiveTransportError);
  });
});

describe("OpenBrainLiveClient.search (primary recall path)", () => {
  it("parses ranked hits from a JSON array body", async () => {
    const body = JSON.stringify([
      { id: "a", source_type: "thoughts", namespace: "ns" },
      { id: "b", source_type: "decisions" },
    ]);
    const client = new OpenBrainLiveClient(
      fakeCaller({ search_brain: [ok(body)] }),
    );
    const hits = await client.search({
      query: "q",
      namespace: "ns",
      limit: 5,
      searchMode: "hybrid",
    });
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("does NOT swallow a denial on the recall path -- it throws", async () => {
    // A denial here means the primary token cannot read its own namespace,
    // which is a misconfiguration and must fail loudly (content-free).
    const client = new OpenBrainLiveClient(
      fakeCaller({ search_brain: [denied("search_brain:permission-denied")] }),
    );
    await expect(
      client.search({
        query: "q",
        namespace: "ns",
        limit: 5,
        searchMode: "hybrid",
      }),
    ).rejects.toThrow(LiveTransportError);
  });
});

describe("OpenBrainLiveClient.attemptRead (isolation probe)", () => {
  it("reports denied=true when the server denies the read", async () => {
    const client = new OpenBrainLiveClient(
      fakeCaller({ search_brain: [denied("search_brain:permission-denied")] }),
    );
    const res = await client.attemptRead({
      query: "q",
      namespace: "neg-ns",
      limit: 5,
      searchMode: "hybrid",
    });
    expect(res).toEqual({ denied: true, hitCount: 0 });
  });

  it("treats an empty successful read as NOT denied (no false isolation proof)", async () => {
    const client = new OpenBrainLiveClient(
      fakeCaller({ search_brain: [ok("[]")] }),
    );
    const res = await client.attemptRead({
      query: "q",
      namespace: "neg-ns",
      limit: 5,
      searchMode: "hybrid",
    });
    // Empty + allowed is the dangerous case the gate must reject as proof.
    expect(res.denied).toBe(false);
    expect(res.hitCount).toBe(0);
  });

  it("reports a non-empty successful read as a leak (denied=false, hitCount>0)", async () => {
    const body = JSON.stringify([{ id: "leak", source_type: "thoughts" }]);
    const client = new OpenBrainLiveClient(
      fakeCaller({ search_brain: [ok(body)] }),
    );
    const res = await client.attemptRead({
      query: "q",
      namespace: "neg-ns",
      limit: 5,
      searchMode: "hybrid",
    });
    expect(res.denied).toBe(false);
    expect(res.hitCount).toBe(1);
  });

  it("throws (not a false proof) on a non-denial transport error", async () => {
    const client = new OpenBrainLiveClient(
      fakeCaller({ search_brain: [errored("search_brain:timeout")] }),
    );
    await expect(
      client.attemptRead({
        query: "q",
        namespace: "neg",
        limit: 5,
        searchMode: "hybrid",
      }),
    ).rejects.toThrow(LiveTransportError);
  });
});

describe("OpenBrainLiveClient.archive", () => {
  it("maps archived=true to 'archived' and the EXACT absent marker to 'already_absent'", async () => {
    const c1 = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok(JSON.stringify({ archived: true }))] }),
    );
    expect(await c1.archive({ table: "thoughts", id: "x" })).toBe("archived");
    // The exact server no-op body (src/tools/archive-entry.ts).
    const c2 = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok("Already archived or not found")] }),
    );
    expect(await c2.archive({ table: "thoughts", id: "y" })).toBe(
      "already_absent",
    );
    // Trimmed + case-insensitive: whitespace/case variants of the exact marker
    // still classify (the server body, tolerantly matched, nothing more).
    const c3 = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok("  ALREADY archived or not found  ")] }),
    );
    expect(await c3.archive({ table: "thoughts", id: "z" })).toBe(
      "already_absent",
    );
  });

  it("FAILS CLOSED on a structured archived=false -- the server never emits it", async () => {
    // archive_entry has exactly two success shapes: {archived:true} or the exact
    // plain-text marker. A structured {archived:false} is an unrecognized shape
    // and must fail closed, never a silent already_absent.
    const c = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok(JSON.stringify({ archived: false }))] }),
    );
    const err = await c
      .archive({ table: "thoughts", id: "y" })
      .catch((e) => e as LiveTransportError);
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err.label).toBe("archive_entry:unrecognized-success");
  });

  it("FAILS CLOSED (throws) on an unrecognized success shape -- never a false already_absent", async () => {
    // The destructive-teardown hole: a success body that neither confirms an
    // archive nor matches the already-absent marker must NOT be silently counted
    // as clean cleanup. That would strand a live record while PASS is reported.
    const ambiguous = new OpenBrainLiveClient(
      fakeCaller({
        archive_entry: [ok(JSON.stringify({ status: "queued", ok: true }))],
      }),
    );
    const ambiguousErr = await ambiguous
      .archive({ table: "thoughts", id: "z" })
      .catch((e) => e as LiveTransportError);
    expect(ambiguousErr).toBeInstanceOf(LiveTransportError);
    // Content-free label: names the tool + a marker, never the raw body.
    expect(ambiguousErr.label).toBe("archive_entry:unrecognized-success");

    // An empty body is also ambiguous -> fail closed.
    const empty = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok("")] }),
    );
    await expect(empty.archive({ table: "thoughts", id: "z" })).rejects.toThrow(
      LiveTransportError,
    );

    // A non-JSON body that is NOT an absent marker is ambiguous -> fail closed.
    const junk = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok("row body: private grommet note")] }),
    );
    const junkErr = junk
      .archive({ table: "thoughts", id: "z" })
      .catch((e) => e as LiveTransportError);
    const resolved = await junkErr;
    expect(resolved).toBeInstanceOf(LiveTransportError);
    expect(resolved.label).not.toContain("grommet");
  });

  it("FAILS CLOSED on partial / mixed-text markers -- only the exact marker passes", async () => {
    // Under the exact-marker contract, a body that merely CONTAINS "not found"
    // (or "no rows", or the marker embedded in incidental text) must NOT be
    // treated as the absent no-op: it could false-pass on unrelated output.
    const cases = [
      "archive_entry: row not found (already tombstoned)", // marker embedded in mixed text
      "not found", // partial substring of the marker
      "no rows", // never a real archive_entry body
      "Already archived or not found. extra tail", // exact marker + trailing text
    ];
    for (const body of cases) {
      const c = new OpenBrainLiveClient(
        fakeCaller({ archive_entry: [ok(body)] }),
      );
      const err = await c
        .archive({ table: "thoughts", id: "y" })
        .catch((e) => e as LiveTransportError);
      expect(err).toBeInstanceOf(LiveTransportError);
      expect(err.label).toBe("archive_entry:unrecognized-success");
    }
  });

  it("throws a redacted LiveTransportError when archive errors", async () => {
    const client = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [errored("archive_entry:error")] }),
    );
    await expect(
      client.archive({ table: "thoughts", id: "z" }),
    ).rejects.toThrow(LiveTransportError);
  });
});

describe("parseHits", () => {
  it("ignores rows without a string id and non-array bodies", () => {
    expect(parseHits("not json")).toEqual([]);
    expect(parseHits(JSON.stringify({ id: "a" }))).toEqual([]);
    expect(
      parseHits(
        JSON.stringify([{ id: 1 }, { id: "ok", source_type: "t" }]),
      ).map((h) => h.id),
    ).toEqual(["ok"]);
  });
});

describe("close delegates to the caller", () => {
  it("calls the caller's close exactly once", async () => {
    let closed = 0;
    const caller: OpenBrainToolCaller = {
      async callTool() {
        return ok("{}");
      },
      async close() {
        closed += 1;
      },
    };
    const client = new OpenBrainLiveClient(caller);
    await client.close();
    expect(closed).toBe(1);
  });
});

describe("sanitizeThrownTransportError (content-free thrown-error boundary)", () => {
  // The SDK can throw an error whose .message carries the raw remote HTTP body,
  // which may include a memory body or secret. The sanitizer must never surface
  // the raw message -- only op + a known keyword / status / bare marker.
  const secret =
    "HTTP 500 body: Permission denied for SECRET-TOKEN-abc123, memory body 'grommet torque note' leaked";

  it("keeps a known keyword and drops everything else", () => {
    const err = sanitizeThrownTransportError("connect", new Error(secret));
    expect(err).toBeInstanceOf(LiveTransportError);
    // "permission denied" is a known keyword and wins over the status code.
    expect(err.label).toBe("connect:permission-denied");
    expect(err.denied).toBe(true);
    expect(err.label).not.toContain("SECRET-TOKEN");
    expect(err.label).not.toContain("grommet");
    expect(err.label).not.toContain("500");
    expect(err.message).toBe("connect:permission-denied");
  });

  it("names only an HTTP status when no keyword matches", () => {
    const err = sanitizeThrownTransportError(
      "search_brain",
      new Error(
        "Unexpected server response 503 body: private note contents here",
      ),
    );
    expect(err.label).toBe("search_brain:http-503");
    expect(err.denied).toBe(false);
    expect(err.label).not.toContain("private note");
  });

  it("collapses an opaque error to <op>:transport-error", () => {
    const err = sanitizeThrownTransportError(
      "log_thought",
      new Error("socket hang up while writing row 4831: grommet torque secret"),
    );
    expect(err.label).toBe("log_thought:transport-error");
    expect(err.label).not.toContain("4831");
    expect(err.label).not.toContain("grommet");
  });

  it("handles a non-Error throw without leaking its stringified body", () => {
    const err = sanitizeThrownTransportError("close", {
      toString: () => "raw object with SECRET-xyz inside",
    });
    expect(err.label).toBe("close:transport-error");
    expect(err.label).not.toContain("SECRET-xyz");
  });

  it("passes an already-redacted LiveTransportError through unchanged", () => {
    const original = new LiveTransportError(
      "search_brain:permission-denied",
      true,
    );
    expect(sanitizeThrownTransportError("connect", original)).toBe(original);
  });
});

/** Build a fake McpClientLike whose methods throw or return scripted results. */
function fakeMcpClient(behavior: {
  connect?: () => Promise<void>;
  callTool?: () => Promise<{ content?: unknown; isError?: boolean }>;
  close?: () => Promise<void>;
}): McpClientLike {
  return {
    async connect() {
      if (behavior.connect) return behavior.connect();
    },
    async callTool() {
      if (behavior.callTool) return behavior.callTool();
      return { content: [{ type: "text", text: "{}" }], isError: false };
    },
    async close() {
      if (behavior.close) return behavior.close();
    },
  };
}

describe("createMcpCaller (concrete boundary sanitization)", () => {
  const baseOpts = {
    baseUrl: "http://127.0.0.1:3100",
    token: "tok",
    namespace: "ns-x",
    timeoutMs: 1000,
  };

  it("sanitizes a thrown connect error (no raw remote body)", async () => {
    const promise = createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          connect: async () => {
            throw new Error("HTTP 401 Unauthorized: token leaked-secret-xyz");
          },
        }),
        transport: {},
      }),
    });
    await expect(promise).rejects.toThrow(LiveTransportError);
    await expect(promise).rejects.toThrow("connect:unauthorized");
    await promise.catch((e) => {
      expect((e as Error).message).not.toContain("leaked-secret-xyz");
    });
  });

  it("sanitizes a thrown callTool error to a content-free label", async () => {
    const caller = await createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          callTool: async () => {
            throw new Error(
              "stream broke: row body 'private grommet note' 500",
            );
          },
        }),
        transport: {},
      }),
    });
    const call = caller.callTool("search_brain", { query: "q" });
    await expect(call).rejects.toThrow(LiveTransportError);
    await call.catch((e) => {
      expect((e as LiveTransportError).label).toBe("search_brain:http-500");
      expect((e as Error).message).not.toContain("grommet");
    });
  });

  it("redacts a server isError body to a content-free label (not thrown)", async () => {
    const caller = await createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          callTool: async () => ({
            content: [
              { type: "text", text: "Permission denied: secret body abc" },
            ],
            isError: true,
          }),
        }),
        transport: {},
      }),
    });
    const res = await caller.callTool("search_brain", { query: "q" });
    expect(res.isError).toBe(true);
    expect(res.denied).toBe(true);
    expect(res.errorLabel).toBe("search_brain:permission-denied");
    expect(res.data).toBe("");
  });

  it("returns the response body only on success, for structured parsing", async () => {
    const body = JSON.stringify({ id: "srv-1", namespace: "ns-x" });
    const caller = await createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          callTool: async () => ({
            content: [{ type: "text", text: body }],
            isError: false,
          }),
        }),
        transport: {},
      }),
    });
    const res = await caller.callTool("log_thought", { content: "c" });
    expect(res.isError).toBe(false);
    expect(res.data).toBe(body);
    expect(res.errorLabel).toBe("");
  });

  it("sanitizes a thrown close error to a content-free label", async () => {
    const caller = await createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          close: async () => {
            throw new Error("close failed 503: leftover private body text");
          },
        }),
        transport: {},
      }),
    });
    const close = caller.close();
    await expect(close).rejects.toThrow(LiveTransportError);
    await close.catch((e) => {
      expect((e as LiveTransportError).label).toBe("close:http-503");
      expect((e as Error).message).not.toContain("private body");
    });
  });
});
