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
// TODO(fleet-nats): file upstream issue to add ob_context_pack(env) builder in
// fleet_nats/subjects.py; this TS mirror must stay in parity.

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
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-")
    .replaceAll(".", "-");
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
