import { describe, expect, it } from "bun:test";
import {
  buildEnvelope,
  envelopeFromBytes,
  envelopeToBytes,
  REQUEST_KIND,
  RESPONSE_FROM,
  RESPONSE_KIND,
} from "./nats-runtime.ts";
import fixture from "./__fixtures__/nats-context-pack-wire.json" with { type: "json" };

// Cross-language wire-parity guard. The fixture at
// src/__fixtures__/nats-context-pack-wire.json is shared verbatim with the
// Python (openbrain-memory) lane so the two implementations cannot drift. TS
// must (a) serialize the canonical request to the EXACT bytes in `request.wire`
// and (b) parse `response.wire` back to the canonical response envelope.

const decoder = new TextDecoder();

describe("shared NATS wire fixture — TS parity", () => {
  it("serializes the canonical request to the exact fixture bytes ('from' key)", () => {
    const env = fixture.request.envelope;
    const built = buildEnvelope({
      id: env.id,
      ts: env.ts,
      from: env.from,
      kind: env.kind,
      payload: env.payload,
      to: env.to,
      task_id: env.task_id,
      channel: env.channel,
      topic: env.topic,
      correlation_id: env.correlation_id,
      version: env.version,
    });

    const wire = decoder.decode(envelopeToBytes(built));
    expect(wire).toBe(fixture.request.wire);
    // Belt-and-suspenders: the wire uses "from", never "sender", and the request
    // kind is the canonical discriminator.
    expect(wire).toContain('"from":"nagatha"');
    expect(wire).not.toContain('"sender"');
    expect(env.kind).toBe(REQUEST_KIND);
    // namespace override rides top-level payload.namespace.
    expect(env.payload.namespace).toBe("rico");
  });

  it("round-trips the canonical request bytes back through the parser", () => {
    const parsed = envelopeFromBytes(
      new TextEncoder().encode(fixture.request.wire),
    );
    expect(parsed).toEqual(fixture.request.envelope as typeof parsed);
    expect(parsed.kind).toBe(REQUEST_KIND);
  });

  it("parses the canonical response wire into the fixture response envelope", () => {
    const parsed = envelopeFromBytes(
      new TextEncoder().encode(fixture.response.wire),
    );

    expect(parsed).toEqual(fixture.response.envelope as typeof parsed);
    expect(parsed.kind).toBe(RESPONSE_KIND);
    expect(parsed.from).toBe(RESPONSE_FROM);
    // correlation_id echoes the request id.
    expect(parsed.correlation_id).toBe(fixture.request.envelope.id);
    // namespace_source is a response-only stamp carried in the payload.
    expect((parsed.payload as Record<string, unknown>).namespace_source).toBe(
      "override",
    );
  });

  it("re-serializes the canonical response to the exact fixture bytes", () => {
    const env = fixture.response.envelope;
    const built = buildEnvelope({
      id: env.id,
      ts: env.ts,
      from: env.from,
      kind: env.kind,
      payload: env.payload,
      to: env.to,
      task_id: env.task_id,
      channel: env.channel,
      topic: env.topic,
      correlation_id: env.correlation_id,
      version: env.version,
    });
    expect(decoder.decode(envelopeToBytes(built))).toBe(fixture.response.wire);
  });
});
