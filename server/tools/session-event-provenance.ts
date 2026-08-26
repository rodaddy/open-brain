import type { AuthIdentity } from "../auth/types.ts";

/**
 * Writer provenance for a session-event write.
 *
 * `append_session_event` (this directory's `session-events.ts`) and
 * `ingest_conversation_facts` both stamp the same four fields onto every
 * `ob_session_events` row they insert, and each carried its own private copy of
 * the derivation. The copies agreed on every value: `tokenClientId` is a
 * required `string` on `AuthIdentity`, so the `?? clientId` fallback one copy
 * carried could never fire.
 *
 * This lives in its own module rather than in `memory-helpers.ts` so that the
 * shared declaration is importable without widening the #780 lane's touched-file
 * set -- `memory-helpers.ts` carries its own separate lint finding that a
 * different rung of the sweep owns.
 */
export function writerProvenance(identity: AuthIdentity): {
  writer_identity: string;
  token_identity: string;
  delegated_agent_id: null;
  namespace_source: "token" | "header";
} {
  return {
    writer_identity: identity.clientId,
    token_identity: identity.tokenClientId,
    delegated_agent_id: null,
    namespace_source:
      identity.namespaceSource === "delegated" ? "header" : "token",
  };
}

/**
 * The `_openbrain.writer` envelope both session-event writers nest inside the
 * metadata they persist. Kept beside `writerProvenance` because the two are
 * always used together and the field renaming between them is the coupling.
 */
export function openBrainWriterMetadata(
  provenance: ReturnType<typeof writerProvenance>,
): { _openbrain: { writer: Record<string, unknown> } } {
  return {
    _openbrain: {
      writer: {
        client_id: provenance.writer_identity,
        token_client_id: provenance.token_identity,
        agent_id: provenance.delegated_agent_id,
        namespace_source: provenance.namespace_source,
      },
    },
  };
}
