import { describe, expect, it } from "vitest";
import {
  OpenBrainLiveClient,
  LiveTransportError,
  isDenialLabel,
  parseHits,
  redactToolFailure,
  sanitizeThrownTransportError,
  type OpenBrainToolCaller,
} from "../transport.ts";
import { ok } from "./transport-test-support.ts";

// The content-free error boundary and the fail-closed parseHits transport
// boundary. The semantic client's own surface is covered in
// ./transport-client-seed.test.ts and ./transport-client-read.test.ts.

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

describe("parseHits (fail-closed transport boundary)", () => {
  // parseHits is the boundary every scored/probed hit passes through. A dropped
  // raw result never reaches the gate-level validator (toFixtureRetrieval), so a
  // malformed body or entry must FAIL CLOSED here, never be silently discarded --
  // discarding would compress ranks or hide a foreign/malformed row before PASS.

  it("FAILS CLOSED on a non-array success body (object) -- not an empty result", () => {
    // The old behavior returned [] for a non-array body, conflating a malformed
    // result set with a real empty read. It must now throw, content-free.
    const err = (() => {
      try {
        parseHits(JSON.stringify({ id: "a" }));
        return undefined;
      } catch (e) {
        return e as LiveTransportError;
      }
    })();
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err?.label).toBe("search_brain:malformed-results");
  });

  it("FAILS CLOSED on a non-array success body (scalar)", () => {
    expect(() => parseHits(JSON.stringify(42))).toThrow(LiveTransportError);
    expect(() => parseHits(JSON.stringify("a string"))).toThrow(LiveTransportError);
  });

  it("FAILS CLOSED on invalid JSON (content-free malformed-results)", () => {
    const err = (() => {
      try {
        parseHits("not json {");
        return undefined;
      } catch (e) {
        return e as LiveTransportError;
      }
    })();
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err?.label).toBe("search_brain:malformed-results");
    // Content-free: the raw body never appears in the label.
    expect(err?.label).not.toContain("not json");
  });

  it("FAILS CLOSED on a non-object array entry -- never silently skipped", () => {
    const err = (() => {
      try {
        parseHits(JSON.stringify([{ id: "ok" }, 7]));
        return undefined;
      } catch (e) {
        return e as LiveTransportError;
      }
    })();
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err?.label).toBe("search_brain:malformed-hit");
  });

  it("FAILS CLOSED on an entry with a missing / non-string id", () => {
    const missing = (() => {
      try {
        parseHits(JSON.stringify([{ source_type: "t" }]));
      } catch (e) {
        return e as LiveTransportError;
      }
    })();
    expect(missing?.label).toBe("search_brain:malformed-hit");

    const nonString = (() => {
      try {
        parseHits(JSON.stringify([{ id: 1, source_type: "t" }]));
      } catch (e) {
        return e as LiveTransportError;
      }
    })();
    expect(nonString?.label).toBe("search_brain:malformed-hit");
  });

  it("FAILS CLOSED on an entry with an EMPTY string id", () => {
    const err = (() => {
      try {
        parseHits(JSON.stringify([{ id: "", source_type: "t" }]));
      } catch (e) {
        return e as LiveTransportError;
      }
    })();
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err?.label).toBe("search_brain:malformed-hit");
  });

  it("preserves rank/order for valid rows and keeps namespace OPTIONAL", () => {
    // Valid rows must survive in order; a valid row WITHOUT a namespace passes
    // this boundary (it reaches gate.ts, which fails it as foreign-namespace) --
    // requiring namespace here would mask that distinct gate-level classification.
    const hits = parseHits(
      JSON.stringify([
        { id: "a", source_type: "thoughts", namespace: "ns" },
        { id: "b", source_type: "decisions" }, // no namespace -> undefined, kept
        { id: "c", source_type: "thoughts", namespace: "ns" },
      ]),
    );
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(hits[0]?.namespace).toBe("ns");
    expect(hits[1]?.namespace).toBeUndefined();
    expect(hits[2]?.namespace).toBe("ns");
  });

  it("returns an empty array for a genuinely empty result set", () => {
    // An empty JSON array is a real "no hits" read, distinct from a malformed
    // body -- it must NOT throw.
    expect(parseHits("[]")).toEqual([]);
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
      new Error("Unexpected server response 503 body: private note contents here"),
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
    const original = new LiveTransportError("search_brain:permission-denied", true);
    expect(sanitizeThrownTransportError("connect", original)).toBe(original);
  });
});
