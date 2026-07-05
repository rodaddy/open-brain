import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "./types.ts";
import {
  appendReadNamespacePredicate,
  canReadNamespace,
  namespaceFilterFor,
  readableNamespaces,
} from "./read-policy.ts";

describe("read-policy", () => {
  it("uses physical shared storage for predicates while accepting canonical input", () => {
    const savedCanonical = process.env.SHARED_NAMESPACE_CANONICAL;
    const savedPhysical = process.env.SHARED_NAMESPACE_PHYSICAL;
    const savedLegacy = process.env.SHARED_NAMESPACE_LEGACY;
    try {
      process.env.SHARED_NAMESPACE_CANONICAL = "public-shared";
      process.env.SHARED_NAMESPACE_PHYSICAL = "shared_storage";
      process.env.SHARED_NAMESPACE_LEGACY = "old_collab";
      const auth: AuthInfo = {
        role: "agent",
        clientId: "bilby",
        namespaceSource: "header",
      };

      expect(readableNamespaces(auth)).toEqual(["bilby", "shared_storage"]);
      expect(canReadNamespace(auth, "public-shared")).toBe(true);
      expect(canReadNamespace(auth, "old_collab")).toBe(false);
      expect(namespaceFilterFor(auth, "public-shared")).toBe("shared_storage");
      expect(
        namespaceFilterFor(auth, undefined, {
          includeLegacySharedFallback: true,
        }),
      ).toEqual(["bilby", "shared_storage", "old_collab"]);
    } finally {
      if (savedCanonical === undefined) delete process.env.SHARED_NAMESPACE_CANONICAL;
      else process.env.SHARED_NAMESPACE_CANONICAL = savedCanonical;
      if (savedPhysical === undefined) delete process.env.SHARED_NAMESPACE_PHYSICAL;
      else process.env.SHARED_NAMESPACE_PHYSICAL = savedPhysical;
      if (savedLegacy === undefined) delete process.env.SHARED_NAMESPACE_LEGACY;
      else process.env.SHARED_NAMESPACE_LEGACY = savedLegacy;
    }
  });

  it("scopes delegated header callers to the header namespace", () => {
    const auth: AuthInfo = {
      role: "agent",
      clientId: "bilby",
      tokenClientId: "agent",
      namespaceSource: "header",
    };

    expect(readableNamespaces(auth)).toEqual(["bilby", "shared-kb"]);
    expect(canReadNamespace(auth, "bilby")).toBe(true);
    expect(canReadNamespace(auth, "shared-kb")).toBe(true);
    // #167: collab is retired. A delegated header agent can no longer read it
    // via any shared path; it is now just another agent namespace it lacks.
    expect(canReadNamespace(auth, "collab")).toBe(false);
    expect(namespaceFilterFor(auth)).toEqual(["bilby", "shared-kb"]);
    // Legacy fallback no longer injects collab by default — the option is inert.
    expect(
      namespaceFilterFor(auth, undefined, { includeLegacySharedFallback: true }),
    ).toEqual(["bilby", "shared-kb"]);
  });

  it("keeps delegated admin scoped when requesting namespace all", () => {
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };

    expect(readableNamespaces(auth)).toEqual(["bilby", "shared-kb"]);
    expect(canReadNamespace(auth, "all")).toBe(false);
  });

  it("adds a read predicate for scoped callers", () => {
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    const params: unknown[] = ["id"];

    const predicate = appendReadNamespacePredicate(auth, params, "source.namespace");

    expect(predicate).toBe(" AND source.namespace = ANY($2::text[])");
    expect(params).toEqual(["id", ["bilby", "shared-kb"]]);
  });

  it("does not add legacy collab to fallback reads by default (#167)", () => {
    // Retirement regression: the legacy fallback option is inert with the
    // default (empty) legacy namespace. No collab predicate is ever emitted.
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    const params: unknown[] = ["id"];

    const predicate = appendReadNamespacePredicate(
      auth,
      params,
      "source.namespace",
      { includeLegacySharedFallback: true },
    );

    expect(predicate).toBe(" AND source.namespace = ANY($2::text[])");
    expect(params).toEqual(["id", ["bilby", "shared-kb"]]);
  });

  it("re-adds a configured legacy namespace to explicit fallback reads (#167 escape hatch)", () => {
    const saved = process.env.SHARED_NAMESPACE_LEGACY;
    try {
      process.env.SHARED_NAMESPACE_LEGACY = "collab";
      const auth: AuthInfo = {
        role: "admin",
        clientId: "bilby",
        tokenClientId: "admin",
        namespaceSource: "header",
      };
      const params: unknown[] = ["id"];
      const predicate = appendReadNamespacePredicate(
        auth,
        params,
        "source.namespace",
        { includeLegacySharedFallback: true },
      );
      expect(predicate).toBe(" AND source.namespace = ANY($2::text[])");
      expect(params).toEqual(["id", ["bilby", "shared-kb", "collab"]]);
    } finally {
      if (saved === undefined) delete process.env.SHARED_NAMESPACE_LEGACY;
      else process.env.SHARED_NAMESPACE_LEGACY = saved;
    }
  });

  it("allows token-sourced admin to request namespace all", () => {
    const auth: AuthInfo = {
      role: "admin",
      clientId: "admin",
      tokenClientId: "admin",
      namespaceSource: "token",
    };

    expect(readableNamespaces(auth)).toBeUndefined();
    expect(canReadNamespace(auth, "all")).toBe(true);
    expect(namespaceFilterFor(auth, "all")).toBeUndefined();
  });

  it("does not add a read predicate for token-sourced admin", () => {
    const params: unknown[] = ["id"];
    const predicate = appendReadNamespacePredicate(
      { role: "admin", clientId: "admin", namespaceSource: "token" },
      params,
    );

    expect(predicate).toBe("");
    expect(params).toEqual(["id"]);
  });
});
