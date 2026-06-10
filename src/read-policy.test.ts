import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "./types.ts";
import {
  canReadNamespace,
  namespaceFilterFor,
  readableNamespaces,
} from "./read-policy.ts";

describe("read-policy", () => {
  it("scopes delegated header callers to the header namespace", () => {
    const auth: AuthInfo = {
      role: "agent",
      clientId: "bilby",
      tokenClientId: "agent",
      namespaceSource: "header",
    };

    expect(readableNamespaces(auth)).toEqual(["bilby"]);
    expect(canReadNamespace(auth, "bilby")).toBe(true);
    expect(canReadNamespace(auth, "collab")).toBe(false);
    expect(namespaceFilterFor(auth)).toEqual(["bilby"]);
  });

  it("allows delegated admin to request namespace all", () => {
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };

    expect(readableNamespaces(auth)).toEqual(["bilby"]);
    expect(canReadNamespace(auth, "all")).toBe(true);
    expect(namespaceFilterFor(auth, "all")).toBeUndefined();
  });
});
