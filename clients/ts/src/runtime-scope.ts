/**
 * The exact-scope half of the runtime: the identity a runtime writes under,
 * and the stored scope an existing lane already carries.
 *
 * Split out of `runtime-support.ts` so each module stays reviewable;
 * `runtime.ts` re-exports every public name here, so no import path changes.
 */

import type { Json } from "./client.ts";
import { ValidationError } from "./policy.ts";
import {
  persistedText,
  requireText,
  type RuntimeScopeCoordinates,
} from "./validation.ts";
import { RuntimeCallError, isRecord } from "./runtime-support.ts";

/** Exact runtime identity used for context-pack recall and lane writes. */
export class RuntimeScope implements RuntimeScopeCoordinates {
  readonly agent: string;
  readonly platform: string;
  readonly server_id: string;
  readonly channel_id: string;
  readonly session_key: string;
  readonly thread_id: string | null;

  constructor(init: {
    agent: string;
    platform: string;
    serverId: string;
    channelId: string;
    sessionKey: string;
    threadId?: string | null;
  }) {
    this.agent = persistedText(init.agent, "agent");
    this.platform = persistedText(init.platform, "platform");
    this.server_id = persistedText(init.serverId, "server_id");
    this.channel_id = persistedText(init.channelId, "channel_id");
    this.session_key = persistedText(init.sessionKey, "session_key");
    this.thread_id =
      init.threadId === undefined || init.threadId === null
        ? null
        : persistedText(init.threadId, "thread_id");
  }

  /** Return the server contract's exact-scope context-pack fields. */
  contextPackArguments(query: string): Json {
    const args: Json = {
      agent: this.agent,
      platform: this.platform,
      server_id: this.server_id,
      channel_id: this.channel_id,
      session_key: this.session_key,
      query: requireText(query, "query"),
    };
    if (this.thread_id !== null) {
      args["thread_id"] = this.thread_id;
    }
    return args;
  }

  /** Return scope-owned lane coordinates supported by `session_start`. */
  startMetadata(): Json {
    const metadata: Json = {
      platform: this.platform,
      server_id: this.server_id,
      channel_id: this.channel_id,
    };
    if (this.thread_id !== null) {
      metadata["thread_id"] = this.thread_id;
    }
    return metadata;
  }

  /** Return exact scope coordinates supported by `session_wrap`. */
  wrapMetadata(): Json {
    return this.startMetadata();
  }
}

/**
 * The exact scope an EXISTING lane already stores, read back off that lane.
 *
 * Peer of `AdoptedLaneScope` in
 * `python/openbrain-memory/src/openbrain_memory/runtime.py` (issue 736,
 * porting PR 732 / ledger item 33). A manual wrap or checkpoint does not own
 * the lane it writes into: the capture hook opens the base lane with `agent`
 * set and every other coordinate NULL, so a wrap that CLAIMS its own
 * coordinates trips the server's one-way fill and the write is refused
 * (issue 646). Operator ruling: the wrap ADOPTS the lane's scope. The server
 * refusal is an isolation boundary and does not move; the client stops
 * asserting a scope it does not own.
 */
export interface AdoptedLaneScope {
  readonly agent: string | null;
  readonly platform: string | null;
  readonly server_id: string | null;
  readonly channel_id: string | null;
  readonly thread_id: string | null;
}

/**
 * Accept a lane coordinate the server stored, or null when it is unset.
 *
 * Deliberately permissive next to `persistedText`: this value came FROM the
 * server describing a lane that already exists, so refusing it cannot prevent
 * a bad write.
 */
function adoptedText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * Read the stored scope off a `session_start` lane object.
 *
 * The server stores `platform` in the lane column `source` and `server_id`
 * inside `metadata`, so the response spelling is translated back to the
 * request spelling here rather than at each call site.
 */
export function adoptedScopeFromResult(result: Json): AdoptedLaneScope {
  const lane = result["lane"];
  if (!isRecord(lane)) {
    throw new RuntimeCallError("session_start result missing lane object");
  }
  const metadata = lane["metadata"];
  return {
    agent: adoptedText(lane["agent"]),
    platform: adoptedText(lane["source"]),
    server_id: isRecord(metadata) ? adoptedText(metadata["server_id"]) : null,
    channel_id: adoptedText(lane["channel_id"]),
    thread_id: adoptedText(lane["thread_id"]),
  };
}

/**
 * Return the lane's own coordinates for a `session_wrap` payload.
 *
 * NULL coordinates are sent as null rather than omitted: the server compares
 * the request against the lane field by field, so a lane whose `channel_id`
 * is NULL is matched by an explicit null and an omitted key is not guaranteed
 * to read the same way.
 */
export function adoptedWrapFields(adopted: AdoptedLaneScope): Json {
  return {
    platform: adopted.platform,
    server_id: adopted.server_id,
    channel_id: adopted.channel_id,
    thread_id: adopted.thread_id,
  };
}

// The server's one-way-fill refusal, lowercased. Matched as a substring
// because the transport wraps it in a call envelope.
const LANE_SCOPE_REFUSAL =
  "existing lane exact scope does not match session_start request";

/**
 * Is this the server refusing to re-point an already-scoped lane?
 *
 * Deliberately narrow. Only THIS refusal triggers adoption: it means "the lane
 * exists and its scope is not yours". A connectivity failure, an auth denial,
 * or any other error keeps its existing behavior — spool, fallback, or a LOST
 * receipt — so a broken transport is never mistaken for a lane worth adopting.
 */
export function isLaneScopeRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(LANE_SCOPE_REFUSAL);
}

/** Rebuild the exact scope a spooled session_start unit was parked under. */
export function spooledStartScope(payload: Json): RuntimeScope {
  try {
    return new RuntimeScope({
      agent: payload["agent"] as string,
      platform: payload["platform"] as string,
      serverId: payload["server_id"] as string,
      channelId: payload["channel_id"] as string,
      sessionKey: payload["session_key"] as string,
      threadId: (payload["thread_id"] as string | undefined) ?? null,
    });
  } catch {
    throw new ValidationError(
      "spooled session_start record does not carry a complete exact scope",
    );
  }
}
