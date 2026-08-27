/**
 * Legacy shared-namespace helper tests (L5 owner, #864).
 *
 * Two properties are asserted here that nothing else in the suite covers.
 * First, an UNCONFIGURED legacy name never matches: `legacySharedNamespace` is
 * `""` by default, so a helper that tested equality alone would report every
 * unnamespaced input as legacy. Second, the frozen-namespace refusal (#167)
 * has three separate off-switches — the operator escape hatch, an unconfigured
 * legacy name, and a write aimed somewhere else — and each is exercised so a
 * later edit cannot collapse them into one.
 */
import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../types.ts";
import type { SharedNamespaceGroup } from "../config/env-groups.ts";
import {
  isLegacySharedNamespace,
  shouldRejectLegacySharedWrite,
} from "./shared-namespace.ts";

const CONFIGURED: SharedNamespaceGroup = {
  canonicalSharedNamespace: "shared-kb",
  physicalSharedNamespace: "shared-kb-v2",
  legacySharedNamespace: "collab",
  legacyFallbackEnabled: false,
  fallbackMinResults: 5,
  sharedNamespace: "shared-kb-v2",
  allowLegacySharedWrites: false,
};

const UNCONFIGURED: SharedNamespaceGroup = {
  ...CONFIGURED,
  legacySharedNamespace: "",
};

function authAs(role: AuthInfo["role"]): AuthInfo {
  return { role, clientId: "lane5-client" };
}

describe("isLegacySharedNamespace", () => {
  it("matches the configured legacy name", () => {
    expect(isLegacySharedNamespace("collab", CONFIGURED)).toBe(true);
  });

  it("never matches when no legacy name is configured", () => {
    expect(isLegacySharedNamespace("", UNCONFIGURED)).toBe(false);
    expect(isLegacySharedNamespace("collab", UNCONFIGURED)).toBe(false);
  });

  it("does not treat the canonical name as legacy", () => {
    expect(isLegacySharedNamespace("shared-kb", CONFIGURED)).toBe(false);
  });
});

describe("shouldRejectLegacySharedWrite", () => {
  it("refuses a non-admin write into the frozen legacy namespace", () => {
    expect(
      shouldRejectLegacySharedWrite(authAs("agent"), "collab", CONFIGURED),
    ).toBe(true);
  });

  it("allows both admin roles through", () => {
    expect(
      shouldRejectLegacySharedWrite(authAs("admin"), "collab", CONFIGURED),
    ).toBe(false);
    expect(
      shouldRejectLegacySharedWrite(authAs("ob-admin"), "collab", CONFIGURED),
    ).toBe(false);
  });

  it("allows the write once the operator opens the escape hatch", () => {
    expect(
      shouldRejectLegacySharedWrite(authAs("agent"), "collab", {
        ...CONFIGURED,
        allowLegacySharedWrites: true,
      }),
    ).toBe(false);
  });

  it("ignores writes aimed at any other namespace", () => {
    expect(
      shouldRejectLegacySharedWrite(authAs("agent"), "shared-kb", CONFIGURED),
    ).toBe(false);
  });

  it("refuses nothing when no legacy name is configured", () => {
    expect(
      shouldRejectLegacySharedWrite(authAs("agent"), "", UNCONFIGURED),
    ).toBe(false);
  });
});
