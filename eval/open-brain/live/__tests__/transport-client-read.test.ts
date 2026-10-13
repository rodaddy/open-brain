import { describe, expect, it } from "vitest";
import { OpenBrainLiveClient, LiveTransportError } from "../transport.ts";
import {
  denied,
  errored,
  fakeCaller,
  ok,
  expectTransportError,
} from "./transport-test-support.ts";

// The semantic client's seed / recall / isolation-probe surface. Every failure
// must be reduced to a content-free label, and the primary recall path must
// never swallow a denial (only the explicit isolation probe may). The redaction
// helpers themselves are covered in ./transport-redaction.test.ts, and the
// concrete MCP caller boundary in ./transport-mcp-caller.test.ts.

describe("OpenBrainLiveClient.search (primary recall path)", () => {
  it("parses ranked hits from a JSON array body", async () => {
    const body = JSON.stringify([
      { id: "a", source_type: "thoughts", namespace: "ns" },
      { id: "b", source_type: "decisions" },
    ]);
    const client = new OpenBrainLiveClient(fakeCaller({ search_brain: [ok(body)] }));
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
    const client = new OpenBrainLiveClient(fakeCaller({ search_brain: [ok("[]")] }));
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
    const client = new OpenBrainLiveClient(fakeCaller({ search_brain: [ok(body)] }));
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

  it("FAILS CLOSED through the shared parseHits on a malformed successful body", async () => {
    // The isolation probe shares parseHits with the primary search. A malformed
    // (non-array) success body must NOT be read as hitCount:0 (an empty allowed
    // read, which would look like a working boundary) -- it must throw, so
    // probeNegativeControl reports the proof as unestablished rather than passing.
    const nonArray = new OpenBrainLiveClient(
      fakeCaller({ search_brain: [ok(JSON.stringify({ hits: [] }))] }),
    );
    const err = expectTransportError(
      await nonArray
        .attemptRead({
          query: "q",
          namespace: "neg",
          limit: 5,
          searchMode: "hybrid",
        })
        .catch((e) => e as LiveTransportError),
    );
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err.label).toBe("search_brain:malformed-results");

    // A malformed hit (missing id) on the probe path also fails closed.
    const badHit = new OpenBrainLiveClient(
      fakeCaller({
        search_brain: [ok(JSON.stringify([{ source_type: "thoughts" }]))],
      }),
    );
    const badHitErr = expectTransportError(
      await badHit
        .attemptRead({
          query: "q",
          namespace: "neg",
          limit: 5,
          searchMode: "hybrid",
        })
        .catch((e) => e as LiveTransportError),
    );
    expect(badHitErr.label).toBe("search_brain:malformed-hit");
  });
});

describe("OpenBrainLiveClient.archive", () => {
  it("maps archived=true (bound to the requested id/table) to 'archived' and the EXACT absent marker to 'already_absent'", async () => {
    const c1 = new OpenBrainLiveClient(
      fakeCaller({
        archive_entry: [
          ok(JSON.stringify({ id: "x", table: "thoughts", archived: true })),
        ],
      }),
    );
    expect(await c1.archive({ table: "thoughts", id: "x" })).toBe("archived");
    // The exact server no-op body (src/tools/archive-entry.ts).
    const c2 = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok("Already archived or not found")] }),
    );
    expect(await c2.archive({ table: "thoughts", id: "y" })).toBe("already_absent");
    // Trimmed + case-insensitive: whitespace/case variants of the exact marker
    // still classify (the server body, tolerantly matched, nothing more).
    const c3 = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok("  ALREADY archived or not found  ")] }),
    );
    expect(await c3.archive({ table: "thoughts", id: "z" })).toBe("already_absent");
  });

  it("FAILS CLOSED on a structured archived=false -- the server never emits it", async () => {
    // archive_entry has exactly two success shapes: {archived:true} or the exact
    // plain-text marker. A structured {archived:false} is an unrecognized shape
    // and must fail closed, never a silent already_absent.
    const c = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok(JSON.stringify({ archived: false }))] }),
    );
    const err = expectTransportError(
      await c
        .archive({ table: "thoughts", id: "y" })
        .catch((e) => e as LiveTransportError),
    );
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err.label).toBe("archive_entry:unrecognized-success");
  });

  it("FAILS CLOSED on archived:true bound to a DIFFERENT id or table", async () => {
    // archived:true says a row was tombstoned but not WHICH row. If the returned
    // id/table do not exactly match this request, the server tombstoned some
    // other row (or the response drifted); crediting it would leave OUR record
    // live while teardown reports clean. Fail closed content-free.
    const wrongId = new OpenBrainLiveClient(
      fakeCaller({
        archive_entry: [
          ok(JSON.stringify({ id: "other", table: "thoughts", archived: true })),
        ],
      }),
    );
    const wrongIdErr = expectTransportError(
      await wrongId
        .archive({ table: "thoughts", id: "x" })
        .catch((e) => e as LiveTransportError),
    );
    expect(wrongIdErr).toBeInstanceOf(LiveTransportError);
    expect(wrongIdErr.label).toBe("archive_entry:identity-mismatch");

    const wrongTable = new OpenBrainLiveClient(
      fakeCaller({
        archive_entry: [
          ok(JSON.stringify({ id: "x", table: "decisions", archived: true })),
        ],
      }),
    );
    const wrongTableErr = expectTransportError(
      await wrongTable
        .archive({ table: "thoughts", id: "x" })
        .catch((e) => e as LiveTransportError),
    );
    expect(wrongTableErr.label).toBe("archive_entry:identity-mismatch");

    // archived:true with the id/table missing entirely is equally unbound.
    const missing = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [ok(JSON.stringify({ archived: true }))] }),
    );
    const missingErr = expectTransportError(
      await missing
        .archive({ table: "thoughts", id: "x" })
        .catch((e) => e as LiveTransportError),
    );
    expect(missingErr.label).toBe("archive_entry:identity-mismatch");
  });
});

describe("OpenBrainLiveClient.archive fail-closed success shapes", () => {
  it("FAILS CLOSED (throws) on an unrecognized success shape -- never a false already_absent", async () => {
    // The destructive-teardown hole: a success body that neither confirms an
    // archive nor matches the already-absent marker must NOT be silently counted
    // as clean cleanup. That would strand a live record while PASS is reported.
    const ambiguous = new OpenBrainLiveClient(
      fakeCaller({
        archive_entry: [ok(JSON.stringify({ status: "queued", ok: true }))],
      }),
    );
    const ambiguousErr = expectTransportError(
      await ambiguous
        .archive({ table: "thoughts", id: "z" })
        .catch((e) => e as LiveTransportError),
    );
    expect(ambiguousErr).toBeInstanceOf(LiveTransportError);
    // Content-free label: names the tool + a marker, never the raw body.
    expect(ambiguousErr.label).toBe("archive_entry:unrecognized-success");

    // An empty body is also ambiguous -> fail closed.
    const empty = new OpenBrainLiveClient(fakeCaller({ archive_entry: [ok("")] }));
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
    const resolved = expectTransportError(await junkErr);
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
      const c = new OpenBrainLiveClient(fakeCaller({ archive_entry: [ok(body)] }));
      const err = expectTransportError(
        await c
          .archive({ table: "thoughts", id: "y" })
          .catch((e) => e as LiveTransportError),
      );
      expect(err).toBeInstanceOf(LiveTransportError);
      expect(err.label).toBe("archive_entry:unrecognized-success");
    }
  });

  it("throws a redacted LiveTransportError when archive errors", async () => {
    const client = new OpenBrainLiveClient(
      fakeCaller({ archive_entry: [errored("archive_entry:error")] }),
    );
    await expect(client.archive({ table: "thoughts", id: "z" })).rejects.toThrow(
      LiveTransportError,
    );
  });
});
