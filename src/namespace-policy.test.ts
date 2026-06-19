import { describe, it, expect } from "bun:test";
import {
  appendWriteNamespacePredicate,
  canWriteNamespace,
  isPromoterIdentity,
  writableNamespaces,
} from "./namespace-policy.ts";
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

  it("promoter is blocked from writing legacy collab (canonical shared-kb only)", () => {
    // Pins the collab-vs-shared-kb boundary: promoter writes canonical
    // shared-kb but must NOT write the legacy collab namespace. A refactor
    // that adds promoter to shouldRejectLegacySharedWrite would break this.
    const auth: AuthInfo = { role: "promoter", clientId: "promoter" };
    expect(canWriteNamespace(auth, "collab").allowed).toBe(false);
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

  it("discord cannot write to collab", () => {
    const auth: AuthInfo = { role: "discord", clientId: "discord-bot" };
    const result = canWriteNamespace(auth, "collab");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("legacy shared namespace");
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
