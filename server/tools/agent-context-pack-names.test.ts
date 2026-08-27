/**
 * Injected shared-namespace names reach the context-pack authorization seam.
 *
 * `buildAgentContextPackPayload` gates the requested namespace before any query
 * runs. That gate used to resolve the shared-namespace set from the environment
 * on every call; it now takes the already-validated set carried on
 * `dependencies.sharedNamespaceNames`. The failure this file guards against is
 * the quiet one: the field is threaded through the call but the helper still
 * consults the environment, so the injected value is accepted and ignored. A
 * canonical name no environment default produces is injected, and the
 * assertions only pass if that value is what the gate actually consulted.
 */
import { describe, expect, test } from "bun:test";
import type { AuthIdentity } from "../auth/types.ts";
import type { MemoryToolDependencies } from "./types.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";
import { buildAgentContextPackPayload } from "./agent-context-pack.ts";

/** A shared-namespace set no environment default could produce by accident. */
const injected: SharedNamespaceConfig = {
  canonicalSharedNamespace: "lane5-canonical-kb",
  physicalSharedNamespace: "lane5-physical-kb",
  legacySharedNamespace: "",
  legacyFallbackEnabled: false,
  fallbackMinResults: 5,
  sharedNamespace: "lane5-physical-kb",
  allowLegacySharedWrites: false,
};

const identity: AuthIdentity = {
  role: "agent",
  clientId: "rico",
  tokenClientId: "rico",
  namespaceSource: "token",
};

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as MemoryToolDependencies["logger"];

/**
 * Dependencies whose pool refuses to be used.
 *
 * The assertions below all resolve on the authorization path, which returns
 * before any statement runs. A pool that throws turns "the gate silently let
 * this through" into a loud test failure instead of a passing one.
 */
function dependenciesWith(
  names?: SharedNamespaceConfig,
): MemoryToolDependencies {
  return {
    pool: {
      query: () => {
        throw new Error("no query should run on the authorization path");
      },
    } as unknown as MemoryToolDependencies["pool"],
    embedFn: async () => null,
    logger: noopLogger,
    sharedNamespaceNames: names,
  };
}

const args = {
  agent: "claude",
  platform: "claude-code",
  server_id: "mac",
  channel_id: "open-brain",
  session_key: "lane-5",
  requested_sections: ["working_set"],
  namespace: injected.canonicalSharedNamespace,
} as unknown as Parameters<typeof buildAgentContextPackPayload>[0];

describe("agent_context_pack honours injected shared-namespace names", () => {
  test("the missing set fails loudly rather than reading as a denial", async () => {
    // Before the names came from config this returned an ordinary permission
    // refusal, which made an unwired composition root indistinguishable from a
    // caller asking for a namespace it genuinely may not read.
    await expect(
      buildAgentContextPackPayload(args, identity, dependenciesWith()),
    ).rejects.toThrow(/sharedNamespaceNames/);
  });

  test("the same name is authorized once the set arrives via dependencies", async () => {
    const result = await buildAgentContextPackPayload(
      args,
      identity,
      dependenciesWith(injected),
    );

    // Authorization passed, so the denial payload is gone. Anything past the
    // gate is out of scope here; what matters is that the gate consulted the
    // injected names rather than the environment.
    expect(JSON.stringify(result.payload)).not.toContain(
      "cannot read namespace",
    );
  });
});
