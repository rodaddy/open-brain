/**
 * Authentication and namespace policy tests.
 * Design authority: `docs/identity-boundary.md` and `docs/decisions/
 * admin-and-promoter-identities.md`.
 */
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { canDelete, canRead, canWrite } from "./permissions.ts";
import {
  canTargetNamespace,
  delegateNamespace,
  namespacePredicate,
} from "./namespace-policy.ts";
import { resolveBearerToken } from "./tokens.ts";
import type { AuthIdentity } from "./types.ts";

const AGENT: AuthIdentity = {
  role: "agent",
  clientId: "bilby",
  tokenClientId: "bilby",
  namespaceSource: "token",
};

describe("token and role authorization", () => {
  it("derives role and client identity only from the configured token", () => {
    const configuredToken = randomUUID();
    const identity = resolveBearerToken(configuredToken, [
      { token: configuredToken, role: "readonly", clientId: "kevin" },
    ]);
    expect(identity).toEqual({
      role: "readonly",
      clientId: "kevin",
      tokenClientId: "kevin",
      namespaceSource: "token",
    });
    expect(resolveBearerToken(randomUUID(), [])).toBeUndefined();
  });

  it("keeps role mistakes out of the permission surface", () => {
    expect(canWrite("readonly", "thoughts")).toBe(false);
    expect(canRead("discord", "thoughts")).toBe(false);
    expect(canDelete("agent", "thoughts")).toBe(false);
    expect(canWrite("promoter", "projects")).toBe(false);
    expect(canDelete("ob-admin", "sessions")).toBe(true);
  });
});

describe("namespace isolation policy", () => {
  it("adds an auth-derived namespace boundary to ID-only operations", () => {
    expect(namespacePredicate(AGENT, "read", 2).values).toEqual([["bilby", "shared-kb"]]);
    expect(namespacePredicate(AGENT, "delete", 2).values).toEqual([["bilby"]]);
  });

  it("rejects attacker namespaces and direct shared truth writes", () => {
    expect(canTargetNamespace(AGENT, "write", "skippy")).toBe(false);
    expect(canTargetNamespace(AGENT, "write", "shared-kb")).toBe(false);
    expect(canTargetNamespace(AGENT, "write", "bilby")).toBe(true);
  });

  it("applies the recorded promoter and global-role rulings", () => {
    const promoter = { ...AGENT, role: "promoter" as const, clientId: "openbrain-promoter" };
    const admin = { ...AGENT, role: "admin" as const, clientId: "rico", tokenClientId: "rico" };
    expect(canTargetNamespace(promoter, "write", "shared-kb")).toBe(true);
    expect(canTargetNamespace(promoter, "read", "all")).toBe(false);
    expect(canTargetNamespace(admin, "read", "all")).toBe(true);
    expect(canTargetNamespace(admin, "write", "shared-kb")).toBe(false);
    expect(canTargetNamespace(admin, "write", "collab")).toBe(false);
  });

  it("permits delegation only for token-authenticated global roles", () => {
    expect(delegateNamespace(AGENT, "skippy")).toBeUndefined();
    const admin = { ...AGENT, role: "admin" as const, clientId: "rico", tokenClientId: "rico" };
    expect(delegateNamespace(admin, "attacker")?.clientId).toBe("attacker");
    expect(delegateNamespace(admin, "all")).toBeUndefined();
  });
});
