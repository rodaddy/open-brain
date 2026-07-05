import { describe, it, expect } from "bun:test";
import {
  appendWriteNamespacePredicate,
  canWriteNamespace,
  isPromoterIdentity,
  writableNamespaces,
} from "./namespace-policy.ts";
import { isLegacySharedNamespace } from "./shared-namespace.ts";
import type { AuthInfo } from "./types.ts";

describe("canWriteNamespace", () => {
  it("admin can write to any namespace", () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    expect(canWriteNamespace(auth, "rico").allowed).toBe(true);
    expect(canWriteNamespace(auth, "bilby").allowed).toBe(true);
    expect(canWriteNamespace(auth, "nagatha").allowed).toBe(true);
  });

  it("n8n can write to any namespace", () => {
    const auth: AuthInfo = { role: "n8n", clientId: "n8n" };
    expect(canWriteNamespace(auth, "bilby").allowed).toBe(true);
  });

  it("requires explicit promoter identity for direct shared-kb writes", () => {
    expect(
      canWriteNamespace({ role: "admin", clientId: "rico" }, "shared-kb"),
    ).toEqual({
      allowed: false,
      reason:
        "shared-kb writes require the openbrain-promoter or hermes-promoter service identity",
    });
    expect(
      canWriteNamespace({ role: "agent", clientId: "bilby" }, "shared-kb")
        .allowed,
    ).toBe(false);
    expect(
      canWriteNamespace(
        { role: "n8n", clientId: "openbrain-promoter" },
        "shared-kb",
      ).allowed,
    ).toBe(true);
  });

  it("allows promoter service identity delegated to shared-kb", () => {
    const auth: AuthInfo = {
      role: "n8n",
      clientId: "shared-kb",
      tokenClientId: "openbrain-promoter",
      namespaceSource: "header",
    };

    expect(isPromoterIdentity(auth)).toBe(true);
    expect(canWriteNamespace(auth, "shared-kb").allowed).toBe(true);
  });

  it("first-class promoter role is a promoter identity by role alone", () => {
    const auth: AuthInfo = { role: "promoter", clientId: "promoter" };
    expect(isPromoterIdentity(auth)).toBe(true);
    expect(canWriteNamespace(auth, "shared-kb").allowed).toBe(true);
    // and can write into agent namespaces it promotes from
    expect(canWriteNamespace(auth, "bilby").allowed).toBe(true);
  });

  it("promoter role does NOT require the legacy promoter clientId convention", () => {
    // role alone is sufficient; clientId is not the openbrain/hermes-promoter literal
    const auth: AuthInfo = { role: "promoter", clientId: "some-service" };
    expect(isPromoterIdentity(auth)).toBe(true);
    expect(canWriteNamespace(auth, "shared-kb").allowed).toBe(true);
  });

  it("non-promoter roles still cannot write shared-kb (regression)", () => {
    for (const role of ["agent", "discord", "readonly"] as const) {
      expect(
        canWriteNamespace({ role, clientId: "x" }, "shared-kb").allowed,
      ).toBe(false);
    }
    // bare admin/n8n (no promoter clientId) still rejected
    expect(
      canWriteNamespace({ role: "admin", clientId: "rico" }, "shared-kb")
        .allowed,
    ).toBe(false);
  });

  it("shared-kb remains promoter-only after collab retirement (#167)", () => {
    // Pins the shared-truth boundary: promoter writes canonical shared-kb.
    // collab is retired (#167) as a legacy shared namespace, so it is no
    // longer specially rejected here — it is just an ordinary (frozen)
    // namespace name. The load-bearing invariant is that shared-kb still
    // requires a promoter identity (asserted elsewhere) and that normal
    // clients cannot write collab (asserted below).
    const auth: AuthInfo = { role: "promoter", clientId: "promoter" };
    expect(canWriteNamespace(auth, "shared-kb").allowed).toBe(true);
  });

  it("header namespace locks admin writes to delegated namespace", () => {
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    expect(canWriteNamespace(auth, "bilby").allowed).toBe(true);
    const result = canWriteNamespace(auth, "skippy");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("X-Namespace");
  });

  it("agent can write to own namespace", () => {
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    expect(canWriteNamespace(auth, "bilby").allowed).toBe(true);
  });

  it("agent cannot write to collab directly", () => {
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const result = canWriteNamespace(auth, "collab");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("collab");
  });

  it("agent cannot write to another agent's namespace", () => {
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const result = canWriteNamespace(auth, "nagatha");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("nagatha");
  });

  it("discord can write to own namespace", () => {
    const auth: AuthInfo = { role: "discord", clientId: "discord-bot" };
    expect(canWriteNamespace(auth, "discord-bot").allowed).toBe(true);
  });

  it("discord cannot write to collab (frozen snapshot, #167)", () => {
    // After collab retirement, collab is a frozen snapshot namespace: writes
    // are rejected for every role. The deny outcome must not regress.
    const auth: AuthInfo = { role: "discord", clientId: "discord-bot" };
    const result = canWriteNamespace(auth, "collab");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("frozen snapshot");
  });

  it("collab is no longer a legacy shared namespace by default (#167)", () => {
    // Regression guard for the retirement: no auth path may treat 'collab' as
    // the legacy shared namespace with the default config. The deny comes from
    // the frozen-snapshot rejection instead.
    expect(isLegacySharedNamespace("collab")).toBe(false);
    const agent: AuthInfo = { role: "agent", clientId: "bilby" };
    const agentResult = canWriteNamespace(agent, "collab");
    expect(agentResult.allowed).toBe(false);
    expect(agentResult.reason).not.toContain("legacy shared namespace");
    expect(agentResult.reason).toContain("frozen snapshot");
  });

  it("frozen collab rejects writes for admin, n8n, and promoter too (#167)", () => {
    // Independent of the legacy mechanism: with collab retired, no role —
    // including global writers — may create rows in the frozen snapshot.
    // Prevents invisible orphans in a namespace nothing reads by default.
    for (const role of ["admin", "n8n", "promoter"] as const) {
      const result = canWriteNamespace(
        { role, clientId: "global-writer" },
        "collab",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("frozen snapshot");
    }
  });

  it("frozen rejection has an explicit operator escape hatch for migration windows", () => {
    // Only the combination SHARED_NAMESPACE_LEGACY=collab AND
    // OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES=1 bypasses the frozen rejection.
    const savedNs = process.env.SHARED_NAMESPACE_LEGACY;
    const savedAllow = process.env.OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES;
    try {
      process.env.SHARED_NAMESPACE_LEGACY = "collab";
      process.env.OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES = "1";
      const admin: AuthInfo = { role: "admin", clientId: "rico" };
      expect(canWriteNamespace(admin, "collab").allowed).toBe(true);
    } finally {
      if (savedNs === undefined) delete process.env.SHARED_NAMESPACE_LEGACY;
      else process.env.SHARED_NAMESPACE_LEGACY = savedNs;
      if (savedAllow === undefined) {
        delete process.env.OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES;
      } else {
        process.env.OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES = savedAllow;
      }
    }
  });

  it("supports re-enabling collab as legacy shared via env escape hatch", () => {
    // The migration window escape hatch: an operator can still set
    // SHARED_NAMESPACE_LEGACY=collab to restore the legacy reject transiently.
    const saved = process.env.SHARED_NAMESPACE_LEGACY;
    try {
      process.env.SHARED_NAMESPACE_LEGACY = "collab";
      expect(isLegacySharedNamespace("collab")).toBe(true);
      const discord: AuthInfo = { role: "discord", clientId: "discord-bot" };
      const result = canWriteNamespace(discord, "collab");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("legacy shared namespace");
    } finally {
      if (saved === undefined) delete process.env.SHARED_NAMESPACE_LEGACY;
      else process.env.SHARED_NAMESPACE_LEGACY = saved;
    }
  });

  it("readonly cannot write to any namespace", () => {
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const result = canWriteNamespace(auth, "viewer");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("readonly");
  });
});

describe("writableNamespaces", () => {
  it("keeps token-sourced admin and n8n broad", () => {
    expect(writableNamespaces({ role: "admin", clientId: "admin" })).toBeUndefined();
    expect(writableNamespaces({ role: "n8n", clientId: "n8n" })).toBeUndefined();
  });

  it("scopes ordinary writers to their own namespace", () => {
    expect(writableNamespaces({ role: "agent", clientId: "bilby" })).toEqual([
      "bilby",
    ]);
    expect(writableNamespaces({ role: "discord", clientId: "discord" })).toEqual([
      "discord",
    ]);
  });

  it("scopes delegated admin to the effective header namespace", () => {
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };

    expect(writableNamespaces(auth)).toEqual(["bilby"]);
  });
});

describe("appendWriteNamespacePredicate", () => {
  it("excludes shared-kb for token-sourced non-promoter admin", () => {
    const params: unknown[] = ["id"];
    const predicate = appendWriteNamespacePredicate(
      { role: "admin", clientId: "admin" },
      params,
    );

    expect(predicate).toBe(" AND namespace <> $2");
    expect(params).toEqual(["id", "shared-kb"]);
  });

  it("adds no predicate for token-sourced promoter identity", () => {
    const params: unknown[] = ["id"];
    const predicate = appendWriteNamespacePredicate(
      { role: "n8n", clientId: "openbrain-promoter" },
      params,
    );

    expect(predicate).toBe("");
    expect(params).toEqual(["id"]);
  });

  it("adds a namespace predicate for scoped writers", () => {
    const params: unknown[] = ["id"];
    const predicate = appendWriteNamespacePredicate(
      { role: "agent", clientId: "bilby" },
      params,
    );

    expect(predicate).toBe(" AND namespace = ANY($2::text[])");
    expect(params).toEqual(["id", ["bilby"]]);
  });
});
