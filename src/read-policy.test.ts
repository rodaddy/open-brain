import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "./types.ts";
import {
  appendReadNamespacePredicate,
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

    expect(readableNamespaces(auth)).toEqual(["bilby", "collab"]);
    expect(canReadNamespace(auth, "bilby")).toBe(true);
    expect(canReadNamespace(auth, "collab")).toBe(true);
    expect(namespaceFilterFor(auth)).toEqual(["bilby", "collab"]);
  });

  it("keeps delegated admin scoped when requesting namespace all", () => {
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };

    expect(readableNamespaces(auth)).toEqual(["bilby", "collab"]);
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
    expect(params).toEqual(["id", ["bilby", "collab"]]);
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
