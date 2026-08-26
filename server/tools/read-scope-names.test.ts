/**
 * Injected shared-namespace names win over the environment.
 *
 * The read-scope helpers historically resolved the shared-namespace set from
 * `process.env` on every call. They now accept the already-validated set from
 * `ServerConfig` as a trailing optional argument. What this file proves is the
 * part that is easy to get silently wrong: the injected value is actually USED,
 * rather than accepted and then ignored in favour of the environment. A
 * distinctive canonical name is passed in, and the assertions fail if the
 * environment default is what the helper consulted.
 */
import { describe, expect, test } from "bun:test";
import type { AuthIdentity } from "../auth/types.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";
import {
  canReadNamespace,
  namespaceFilterFor,
  readableNamespaces,
  appendReadNamespacePredicate,
} from "./read-scope.ts";

/** A shared-namespace set no environment default could produce by accident. */
const injected: SharedNamespaceConfig = {
  canonicalSharedNamespace: "lane3-canonical-kb",
  physicalSharedNamespace: "lane3-physical-kb",
  legacySharedNamespace: "",
  legacyFallbackEnabled: false,
  fallbackMinResults: 5,
};

const identity: AuthIdentity = {
  role: "agent",
  clientId: "rico",
  tokenClientId: "rico",
  namespaceSource: "token",
};

describe("read-scope helpers honour injected shared-namespace names", () => {
  test("readableNamespaces returns the injected physical shared namespace", () => {
    expect(() => readableNamespaces(identity)).toThrow(/sharedNamespaceNames/);
    expect(readableNamespaces(identity, {}, injected)).toEqual([
      "rico",
      "lane3-physical-kb",
    ]);
  });

  test("canReadNamespace authorizes the injected canonical name, not the default", () => {
    expect(() => canReadNamespace(identity, "lane3-canonical-kb")).toThrow(
      /sharedNamespaceNames/,
    );
    expect(canReadNamespace(identity, "lane3-canonical-kb", injected)).toBe(
      true,
    );
    expect(canReadNamespace(identity, "shared-kb", injected)).toBe(false);
  });

  test("namespaceFilterFor translates through the injected names", () => {
    expect(() => namespaceFilterFor(identity, "lane3-canonical-kb")).toThrow(
      /sharedNamespaceNames/,
    );
    expect(
      namespaceFilterFor(identity, "lane3-canonical-kb", {}, injected),
    ).toBe("lane3-physical-kb");
    expect(namespaceFilterFor(identity, undefined, {}, injected)).toEqual([
      "rico",
      "lane3-physical-kb",
    ]);
  });

  test("appendReadNamespacePredicate binds the injected namespaces", () => {
    const params: unknown[] = [];
    const sql = appendReadNamespacePredicate(identity, params, "t.namespace", {
      names: injected,
    });

    expect(sql).toBe(" AND t.namespace = ANY($1::text[])");
    expect(params).toEqual([["rico", "lane3-physical-kb"]]);
  });
});
