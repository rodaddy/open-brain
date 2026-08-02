/**
 * NATS runtime boundary, at the config layer.
 *
 * Design authority: `docs/nats-jetstream-foundation.md` ("Python Client
 * Status") is the rule set being preserved -- NATS is opt-in and advertises
 * availability only when explicitly enabled; HTTP workers keep
 * `OPENBRAIN_TRANSPORT=http` with the bridge off even on a host that has a
 * local broker; and a remote plaintext `nats://` URL is NOT runtime-available
 * unless the explicit lab override is set. `_plans/463-server-rewrite-charter.md`
 * section 3 moves the DERIVATION of that rule set into `server/config/`, which
 * is the only delta: the rules themselves are unchanged from
 * `src/nats-runtime.ts`.
 *
 * The one addition is `unavailableReason`. Availability alone collapses "the
 * operator did not ask for NATS" and "the operator asked and the broker URL is
 * a typo" into the same silent `not_runtime_available`, which is exactly the
 * indistinguishability the src implementation logs a warning about.
 */
import { describe, expect, it } from "bun:test";
import { natsHealthFromConfig, parseNatsConfig } from "./nats.ts";

const NATS_ON = {
  OPENBRAIN_TRANSPORT: "nats",
  OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
  OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
};

describe("nats config boundary", () => {
  it("defaults an HTTP worker to http transport with the bridge unavailable", () => {
    const config = parseNatsConfig({});
    expect(config.requestedTransport).toBe("http");
    expect(config.availability).toBe("not_runtime_available");
    expect(config.unavailableReason).toBe("transport_not_requested");
    expect(config.fallbackTransport).toBe("http_mcp");
    // Fallback to HTTP/MCP is the default and must stay on unless switched off.
    expect(config.fallbackHttp).toBe(true);
  });

  it("reports available only when transport, bridge, and a local url all agree", () => {
    const config = parseNatsConfig(NATS_ON);
    expect(config.availability).toBe("available");
    expect(config.unavailableReason).toBeNull();
  });

  it("keeps the bridge unavailable on an http worker that has a local broker", () => {
    // The design doc requires exactly this: an HTTP worker on a host that also
    // runs a broker and a NATS worker still advertises nothing.
    const config = parseNatsConfig({
      ...NATS_ON,
      OPENBRAIN_TRANSPORT: "http",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "false",
    });
    expect(config.availability).toBe("not_runtime_available");
    expect(config.unavailableReason).toBe("transport_not_requested");
  });

  it("names a disabled bridge separately from an unrequested transport", () => {
    const config = parseNatsConfig({
      ...NATS_ON,
      OPENBRAIN_NATS_ENABLE_BRIDGE: "false",
    });
    expect(config.unavailableReason).toBe("bridge_disabled");
  });

  it("refuses a remote plaintext broker url by default", () => {
    const config = parseNatsConfig({
      ...NATS_ON,
      OPENBRAIN_NATS_URL: "nats://10.71.1.99:4222",
    });
    expect(config.availability).toBe("not_runtime_available");
    expect(config.unavailableReason).toBe("url_remote_not_allowed");
  });

  it("allows a remote broker url only under the explicit lab override", () => {
    const config = parseNatsConfig({
      ...NATS_ON,
      OPENBRAIN_NATS_URL: "nats://10.71.1.99:4222",
      OPENBRAIN_NATS_ALLOW_INSECURE_REMOTE: "true",
    });
    expect(config.availability).toBe("available");
    expect(config.unavailableReason).toBeNull();
  });

  it("fails closed on an unparseable url and says so", () => {
    // The distinguishing case. Before `unavailableReason`, a typo here was
    // indistinguishable from a deliberate configuration choice, so an operator
    // debugging a silent bridge had no signal pointing at the URL.
    const config = parseNatsConfig({ ...NATS_ON, OPENBRAIN_NATS_URL: "not a url" });
    expect(config.availability).toBe("not_runtime_available");
    expect(config.unavailableReason).toBe("url_unparseable");
  });

  it("forces the namespace override off whenever auth is required", () => {
    // Mutually exclusive by design: the override is a local-trust affordance,
    // so an authenticated caller must not additionally be able to name any
    // namespace it likes.
    const config = parseNatsConfig({
      ...NATS_ON,
      OPENBRAIN_NATS_REQUIRE_AUTH: "true",
      OPENBRAIN_NATS_ALLOW_NAMESPACE_OVERRIDE: "true",
    });
    expect(config.requireAuth).toBe(true);
    expect(config.allowNamespaceOverride).toBe(false);
  });

  it("resolves the env-prefixed subject and honors the explicit override", () => {
    expect(parseNatsConfig({}).contextPackSubject).toBe("dev.ob.memory.context_pack");
    expect(parseNatsConfig({ OPENBRAIN_NATS_ENV: "prod" }).contextPackSubject).toBe(
      "prod.ob.memory.context_pack",
    );
    expect(
      parseNatsConfig({ OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT: "ob.custom" })
        .contextPackSubject,
    ).toBe("ob.custom");
  });

  it("never puts the broker url into the health projection", () => {
    // `/health` is unauthenticated and the broker url may carry credentials.
    const config = parseNatsConfig({
      ...NATS_ON,
      OPENBRAIN_NATS_URL: "nats://user:secret@127.0.0.1:4222",
    });
    const health = natsHealthFromConfig(config);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("user");
    expect(health.requested_transport).toBe("nats");
  });

  it("redacts a live bridge error rather than reporting it", () => {
    const health = natsHealthFromConfig(parseNatsConfig(NATS_ON), {
      consecutiveFailures: 3,
      lastError: true,
    });
    expect(health.consecutive_failures).toBe(3);
    expect(health.last_error).toBe("redacted");
  });
});
