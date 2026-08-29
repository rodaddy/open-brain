// Subject-naming convention for the fleet bus, mirrored into TypeScript.
//
// This is the TS mirror of fleet-bus'
// `packages/fleet-nats/src/fleet_nats/subjects.py` (rodaddy/fleet-bus).
// fleet uses the live King convention `{env}.{domain}.{...}` — dot-delimited,
// env-prefixed, hierarchical — and builds every subject through helpers so
// nothing downstream hand-formats a subject string.
//
// Open Brain's context-pack subject slots into that tree as
// `{env}.ob.memory.context_pack`. The `ob` domain is Open-Brain-owned.
//
// The upstream builder now EXISTS: fleet-bus 2b20f97 (2026-07-28) added
// `fleet_nats.subjects.ob_context_pack(env)`, which cites this TS mirror as the
// parity target (its env token is slugged specifically to match
// `obContextPackSubject`). The Python client defers to it when fleet-nats is
// importable; TypeScript cannot import a Python package, so this mirror stays.
//
// KNOWN GAP (open-brain #550): upstream's `slug` also REJECTS `>`, the NATS
// multi-token wildcard (fleet-bus #222), and `slugSubjectToken` below does not.
// Adding it here changes which env strings this runtime accepts, so it is a
// deliberate follow-up rather than a silent tightening inside a mirror refresh.
// Not currently reachable: `env` is supplied by config, which uses dev, prod,
// or staging. The Python drift canary
// (`python/openbrain-memory/tests/test_nats_wire_drift.py`) pins the Python
// side against the clone; this comment is the TS side's marker.

/**
 * Normalise a token for use in a subject (no dots or spaces).
 *
 * Matches fleet's `_slug`: lowercase, spaces and dots collapse to hyphens, and
 * a token that normalises to empty (e.g. whitespace-only) throws — an empty
 * token would silently produce an invalid NATS subject like `dev.ob..x` that
 * the server rejects, losing the message far from the cause.
 *
 * @throws {Error} If the token normalises to an empty string.
 */
export function slugSubjectToken(value: string): string {
  const slug = value.trim().toLowerCase().replaceAll(" ", "-").replaceAll(".", "-");
  if (!slug) {
    throw new Error(`subject token normalises to empty: ${JSON.stringify(value)}`);
  }
  return slug;
}

/**
 * Subject for Open Brain's agent context-pack request/reply lane.
 *
 * Mirrors fleet's `{env}.{domain}.{...}` shape: `{env}.ob.memory.context_pack`.
 * The env token is slugged (fleet convention); the fixed `ob.memory.context_pack`
 * tail is a stable, already-normalised literal so it stays byte-identical to the
 * pre-fleet flat subject minus the env prefix.
 *
 * @param env Environment prefix (e.g. "dev", "prod"). Slugged before use.
 */
export function obContextPackSubject(env: string): string {
  return `${slugSubjectToken(env)}.ob.memory.context_pack`;
}
