import { describe, expect, it } from "bun:test";

import { OpenBrainHTTPError, OpenBrainProtocolError } from "../src/client.ts";
import { ValidationError } from "../src/policy.ts";
import {
  PUBLIC_ERROR_CATEGORIES,
  coerceErrorCategory,
  errorCategory,
  publicReceipt,
} from "../src/receipts.ts";
import {
  ReceiptStatus,
  RuntimeReceipt,
  ScopeProofError,
} from "../src/runtime.ts";
import { SpoolFullError } from "../src/spool.ts";

describe("error category mapping", () => {
  it("maps each failure class into the bounded taxonomy", () => {
    expect(errorCategory(new ScopeProofError("scope mismatch"))).toBe(
      "scope-proof-failed",
    );
    expect(
      errorCategory(new OpenBrainHTTPError("denied", { statusCode: 401 })),
    ).toBe("http-auth");
    expect(
      errorCategory(new OpenBrainHTTPError("denied", { statusCode: 403 })),
    ).toBe("http-auth");
    expect(
      errorCategory(new OpenBrainHTTPError("boom", { statusCode: 500 })),
    ).toBe("http-error");
    expect(errorCategory(new OpenBrainHTTPError("unreachable"))).toBe(
      "network",
    );
    expect(errorCategory(new OpenBrainProtocolError("bad payload"))).toBe(
      "http-error",
    );
    expect(errorCategory(new SpoolFullError("full"))).toBe("spool-full");
    expect(errorCategory(new ValidationError("bad input"))).toBe(
      "invalid-request",
    );
    expect(errorCategory(new Error("anything else"))).toBe("other");
    expect(errorCategory("a thrown string")).toBe("other");
    expect(errorCategory(undefined)).toBe("other");
  });

  it("never emits a value outside the taxonomy", () => {
    const samples: unknown[] = [
      new ScopeProofError("x"),
      new OpenBrainHTTPError("x", { statusCode: 404 }),
      new SpoolFullError("x"),
      new ValidationError("x"),
      new RangeError("x"),
      null,
      42,
      "free text",
    ];
    const taxonomy = new Set<string>(PUBLIC_ERROR_CATEGORIES);
    for (const sample of samples) {
      expect(taxonomy.has(errorCategory(sample))).toBe(true);
    }
    expect(coerceErrorCategory("not-a-real-category")).toBe("other");
    expect(coerceErrorCategory("network")).toBe("network");
    expect(coerceErrorCategory(123)).toBe("other");
  });
});

describe("public receipts", () => {
  function receipt(status: (typeof ReceiptStatus)[keyof typeof ReceiptStatus]) {
    return new RuntimeReceipt({
      operation: "capture",
      status,
      durable:
        status === ReceiptStatus.SAVED || status === ReceiptStatus.SPOOLED,
      directAttempted: true,
      fallbackAttempted: false,
      spoolKey: status === ReceiptStatus.SPOOLED ? "spool-key-1" : null,
      error: status === ReceiptStatus.SAVED ? null : "sanitized internal text",
    });
  }

  it("carries error_category only on non-saved statuses", () => {
    const saved = publicReceipt(receipt(ReceiptStatus.SAVED));
    expect("error_category" in saved).toBe(false);
    for (const status of [
      ReceiptStatus.SPOOLED,
      ReceiptStatus.FAILED,
      ReceiptStatus.LOST,
    ]) {
      const value = publicReceipt(receipt(status), new OpenBrainHTTPError("x"));
      expect(value["error_category"]).toBe("network");
      expect(value["schema"]).toBe("openbrain.public_receipt.v1");
    }
  });

  it("keeps free error text off the public shape", () => {
    const value = publicReceipt(
      receipt(ReceiptStatus.FAILED),
      new Error("free text with details"),
    );
    expect(value["error_category"]).toBe("other");
    expect(JSON.stringify(value)).not.toContain("free text with details");
    expect(JSON.stringify(value)).not.toContain("sanitized internal text");
  });

  it("links the spool key for spooled receipts", () => {
    const value = publicReceipt(
      receipt(ReceiptStatus.SPOOLED),
      new SpoolFullError("full"),
    );
    expect(value["spool_key"]).toBe("spool-key-1");
    expect(value["error_category"]).toBe("spool-full");
    expect(value["durable"]).toBe(true);
  });
});
