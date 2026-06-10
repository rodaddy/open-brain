import { describe, it, expect } from "bun:test";
import { canWriteNamespace } from "./namespace-policy.ts";
import type { AuthInfo } from "./types.ts";

describe("canWriteNamespace", () => {
  it("admin can write to any namespace", () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    expect(canWriteNamespace(auth, "rico").allowed).toBe(true);
    expect(canWriteNamespace(auth, "collab").allowed).toBe(true);
    expect(canWriteNamespace(auth, "bilby").allowed).toBe(true);
    expect(canWriteNamespace(auth, "nagatha").allowed).toBe(true);
  });

  it("n8n can write to any namespace", () => {
    const auth: AuthInfo = { role: "n8n", clientId: "n8n" };
    expect(canWriteNamespace(auth, "collab").allowed).toBe(true);
    expect(canWriteNamespace(auth, "bilby").allowed).toBe(true);
  });

  it("agent can write to own namespace", () => {
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    expect(canWriteNamespace(auth, "bilby").allowed).toBe(true);
  });

  it("agent can write to collab", () => {
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    expect(canWriteNamespace(auth, "collab").allowed).toBe(true);
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
    expect(result.reason).toContain("discord");
  });

  it("readonly cannot write to any namespace", () => {
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const result = canWriteNamespace(auth, "viewer");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("readonly");
  });
});
