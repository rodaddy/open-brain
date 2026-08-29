// Fleet envelope wire codec for the NATS context-pack transport: the TS mirror
// of fleet_nats.envelope.Envelope, plus its build/encode/decode helpers.
// Split out of nats-runtime.ts (issue 864) so that module keeps to the
// runtime-boundary and bridge-planning responsibility.
import { ENVELOPE_VERSION } from "./nats-runtime.ts";

// ---------------------------------------------------------------------------
// Fleet Envelope — TS mirror of fleet_nats.envelope.Envelope.
// ---------------------------------------------------------------------------

export interface FleetEnvelope {
  id: string;
  ts: string;
  from: string;
  kind: string;
  payload: Record<string, unknown>;
  to: string | null;
  task_id: string | null;
  channel: string | null;
  topic: string | null;
  correlation_id: string | null;
  version: number;
}

/**
 * Raised when envelope wire bytes are undecodable or miss required fields.
 * Distinguishing this from Zod/Syntax errors lets the bridge classify a
 * malformed message as a bad request without leaking parser internals.
 */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

function requireEnvelopeString(field: string, value: unknown): string {
  // Mirror fleet's _require_str: a JSON null/missing/non-string required field
  // must be rejected. String(None)->"None" would pass a naive non-empty check,
  // so reject anything that is not already a non-empty string.
  if (typeof value !== "string" || value.length === 0) {
    throw new EnvelopeError(
      `Envelope.fromBytes: required field '${field}' must be a non-empty string`,
    );
  }
  return value;
}

function optEnvelopeString(value: unknown): string | null {
  // Mirror fleet's _opt_str: null stays null; anything else is stringified so a
  // numeric "to": 123 does not masquerade as a string downstream.
  return value === null || value === undefined ? null : String(value);
}

export interface BuildEnvelopeInput {
  id: string;
  ts: string;
  from: string;
  kind: string;
  payload?: Record<string, unknown>;
  to?: string | null;
  task_id?: string | null;
  channel?: string | null;
  topic?: string | null;
  correlation_id?: string | null;
  version?: number;
}

/**
 * Construct a fleet envelope with caller-supplied id and timestamp. Mirrors
 * fleet's Envelope.new + __post_init__ guards: id/from/kind must be non-empty.
 */
function assertEnvelopeIdentity(input: BuildEnvelopeInput): void {
  if (!input.id) throw new EnvelopeError("Envelope.id must be non-empty");
  if (!input.from) throw new EnvelopeError("Envelope.from must be non-empty");
  if (!input.kind) throw new EnvelopeError("Envelope.kind must be non-empty");
}

export function buildEnvelope(input: BuildEnvelopeInput): FleetEnvelope {
  assertEnvelopeIdentity(input);
  return {
    id: input.id,
    ts: input.ts,
    from: input.from,
    kind: input.kind,
    payload: input.payload ?? {},
    to: input.to ?? null,
    task_id: input.task_id ?? null,
    channel: input.channel ?? null,
    topic: input.topic ?? null,
    correlation_id: input.correlation_id ?? null,
    version: input.version ?? ENVELOPE_VERSION,
  };
}

/** Serialise an envelope to compact UTF-8 JSON wire bytes (fleet to_bytes). */
export function envelopeToBytes(envelope: FleetEnvelope): Uint8Array {
  const body = {
    id: envelope.id,
    ts: envelope.ts,
    from: envelope.from,
    kind: envelope.kind,
    payload: envelope.payload,
    to: envelope.to,
    task_id: envelope.task_id,
    channel: envelope.channel,
    topic: envelope.topic,
    correlation_id: envelope.correlation_id,
    version: envelope.version,
  };
  return new TextEncoder().encode(JSON.stringify(body));
}

/**
 * Parse a fleet envelope from wire bytes (fleet from_bytes).
 *
 * @param onVersionWarning Invoked when version > ENVELOPE_VERSION so the caller
 *   controls how the forward-compat warning is surfaced (fleet logs a warning;
 *   never fails closed, never accepts silently).
 * @throws {EnvelopeError} On undecodable JSON, non-object body, non-object
 *   payload, invalid version, or missing/empty required fields.
 */
function decodeEnvelopeRecord(raw: Uint8Array): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch (err) {
    throw new EnvelopeError(
      `Envelope.fromBytes: undecodable message: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EnvelopeError("Envelope.fromBytes: message is not a JSON object");
  }
  return body as Record<string, unknown>;
}

// payload MUST be a JSON object. A list/str/number would satisfy decode but
// break every handler that reads payload.<key>. Reject it here so one
// malformed publisher cannot poison subscribers.
function readEnvelopePayload(rawPayload: unknown): Record<string, unknown> {
  if (rawPayload === undefined || rawPayload === null) return {};
  if (typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    return rawPayload as Record<string, unknown>;
  }
  throw new EnvelopeError(
    `Envelope.fromBytes: payload must be a JSON object, got ${Array.isArray(rawPayload) ? "array" : typeof rawPayload}`,
  );
}

// version must be an integer. A JSON null/string/float is rejected rather than
// coerced, so a malformed version can't slip past the forward-compat gate.
function readEnvelopeVersion(
  rawInput: unknown,
  onVersionWarning?: (version: number) => void,
): number {
  const rawVersion = rawInput ?? ENVELOPE_VERSION;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
    throw new EnvelopeError(
      `Envelope.fromBytes: invalid version ${JSON.stringify(rawVersion)}`,
    );
  }
  if (rawVersion > ENVELOPE_VERSION) {
    // Forward-compat: a newer producer may carry fields we drop or reinterpret.
    // Warn but accept; never fail closed, never accept silently.
    onVersionWarning?.(rawVersion);
  }
  return rawVersion;
}

export function envelopeFromBytes(
  raw: Uint8Array,
  onVersionWarning?: (version: number) => void,
): FleetEnvelope {
  const record = decodeEnvelopeRecord(raw);
  const payload = readEnvelopePayload(record.payload);
  const version = readEnvelopeVersion(record.version, onVersionWarning);

  return {
    id: requireEnvelopeString("id", record.id),
    ts: requireEnvelopeString("ts", record.ts),
    from: requireEnvelopeString("from", record.from),
    kind: requireEnvelopeString("kind", record.kind),
    payload,
    to: optEnvelopeString(record.to),
    task_id: optEnvelopeString(record.task_id),
    channel: optEnvelopeString(record.channel),
    topic: optEnvelopeString(record.topic),
    correlation_id: optEnvelopeString(record.correlation_id),
    version,
  };
}
