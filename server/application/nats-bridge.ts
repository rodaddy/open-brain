import { BackgroundTraceRecorder } from "./background-tracing.ts";
import { logger } from "../../src/logger.ts";
import type { FleetEnvelope } from "./nats-runtime.ts";
import { envelopeFromBytes, envelopeToBytes } from "./nats-runtime.ts";
import type {
  NatsBridgeHealth,
  NatsBridgeRuntime,
  NatsRequestMessage,
  StartNatsContextPackBridgeOptions,
} from "./nats-bridge-types.ts";
import {
  responseOutcome,
  safeErrorType,
  undeliverableReplyEnvelope,
} from "./nats-bridge-envelope.ts";
import { handleNatsContextPackMessage } from "./nats-bridge-handler.ts";
import {
  createNatsJsDriver,
  markNatsBridgeAvailable,
  markNatsBridgeUnavailable,
} from "./nats-bridge-driver.ts";

export type {
  NatsBridgeDriver,
  NatsBridgeHealth,
  NatsBridgeRuntime,
  NatsRequestMessage,
  NatsSubscriptionHandle,
  StartNatsContextPackBridgeOptions,
} from "./nats-bridge-types.ts";
// NamespaceSource (the response-contract type) is owned by nats-runtime.ts; keep
// a re-export so existing importers of it from this module still resolve.
export type { NamespaceSource } from "./nats-runtime.ts";
export { handleNatsContextPackMessage } from "./nats-bridge-handler.ts";

export function createNatsBridgeHealth(
  availability: NatsBridgeHealth["availability"] = "not_runtime_available",
): NatsBridgeHealth {
  return {
    availability,
    consecutiveFailures: 0,
    lastError: null,
  };
}

function hasDeclaredSessionKey(data: Uint8Array): boolean {
  try {
    const envelope = envelopeFromBytes(data);
    const payload = envelope.payload as { identity?: unknown } | undefined;
    const identity = payload?.identity as { session_key?: unknown } | undefined;
    return typeof identity?.session_key === "string" && identity.session_key.length > 0;
  } catch (error: unknown) {
    logger.debug("NATS trace declared session key unavailable", {
      error_type: safeErrorType(error),
    });
    return false;
  }
}

interface NatsReplyResult {
  outcome:
    | "published"
    | "undeliverable_error_published"
    | "error_envelope_exceeded"
    | "no_reply_inbox";
  error?: Record<string, unknown>;
}

/**
 * The nats.js client's own code for a publish it will not carry.
 *
 * `ErrorCode.MaxPayloadExceeded` in `nats-base-client/core.js`. Reproduced as a
 * literal rather than imported so this seam stays testable without a live
 * client and so the bridge's own driver interface (which is what the tests
 * drive) does not gain a hard dependency on the client's module shape.
 */
const NATS_MAX_PAYLOAD_EXCEEDED_CODE = "MAX_PAYLOAD_EXCEEDED";

/**
 * Is this the client's refusal to carry a publish of this length?
 *
 * Matched on the error's `code`, NEVER on its message text. `NatsError` carries
 * a stable machine code while its message is prose the client is free to
 * reword; matching prose would reopen #549 silently on a client upgrade.
 */
function isMaxPayloadExceededError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === NATS_MAX_PAYLOAD_EXCEEDED_CODE
  );
}

/**
 * Attempt the ordinary reply publish. Returns true when the reply was carried;
 * false when it was pre-judged as over the broker's advertised figure, or when
 * the client itself refused it by the MaxPayloadExceeded code. Any other throw
 * is not ours to interpret and propagates unchanged.
 */
async function tryPublishReply(
  message: NatsRequestMessage,
  encoded: Uint8Array,
  advertised: number | undefined,
): Promise<boolean> {
  const exceedsAdvertised =
    typeof advertised === "number" &&
    Number.isFinite(advertised) &&
    advertised > 0 &&
    encoded.byteLength > advertised;
  if (exceedsAdvertised) return false;

  // The advertised figure was unreadable or the reply fits it, so the publish
  // is worth attempting. It can still be rejected by the client itself, and
  // the real nats.js client rejects by THROWING rather than returning false —
  // an unguarded call here would let that escape to the handler-error catch
  // and hand the caller silence, which is the whole #549 defect.
  try {
    const responded = await message.respond(encoded);
    if (responded !== false) return true;
  } catch (err) {
    if (!isMaxPayloadExceededError(err)) throw err;
  }
  return false;
}

/**
 * Publish the content-free error envelope for a reply the broker would not
 * carry, and report which of the three undeliverable readings actually applies.
 */
async function publishUndeliverableReply(
  message: NatsRequestMessage,
  response: FleetEnvelope,
  replyBytes: number,
  advertised: number | undefined,
): Promise<NatsReplyResult> {
  const undeliverable = undeliverableReplyEnvelope(
    message,
    response,
    replyBytes,
    advertised,
  );
  let respondedWithError: boolean | void;
  try {
    respondedWithError = await message.respond(envelopeToBytes(undeliverable));
  } catch (err) {
    if (!isMaxPayloadExceededError(err)) throw err;
    // Even the content-free envelope was rejected against the advertised
    // figure. The bridge has nothing further it can put on the wire, so it
    // records what happened and stops.
    logger.error("NATS error envelope exceeded the broker's advertised figure", {
      subject: message.subject,
      reply_bytes: replyBytes,
      broker_advertised_bytes: advertised ?? null,
    });
    return {
      outcome: "error_envelope_exceeded",
      error: {
        code: "payload_too_large",
        reply_bytes: replyBytes,
        broker_advertised_bytes: advertised ?? null,
      },
    };
  }

  if (respondedWithError === false) {
    // Only now is "no reply inbox" the accurate reading: the client returns
    // false for exactly one condition, and it is not about the figure.
    logger.error("NATS reply could not be published to a reply inbox", {
      subject: message.subject,
      reply_bytes: replyBytes,
    });
    return {
      outcome: "no_reply_inbox",
      error: { code: "reply_inbox_missing", reply_bytes: replyBytes },
    };
  }

  logger.warn("NATS reply exceeded the broker's advertised payload figure", {
    subject: message.subject,
    reply_bytes: replyBytes,
    broker_advertised_bytes: advertised ?? null,
    correlation_id: response.correlation_id,
  });
  return {
    outcome: "undeliverable_error_published",
    error: {
      code: "payload_too_large",
      reply_bytes: replyBytes,
      broker_advertised_bytes: advertised ?? null,
    },
  };
}

/**
 * Publish a reply, answering an undeliverable one with an error envelope.
 *
 * THE DEFECT THIS CLOSES (#549): the handler finishes its work, builds a large
 * pack, and the reply publish cannot be carried. In the real nats.js client
 * that surfaces as a THROW, not a false return: `Msg.respond()` publishes
 * through `protocol.publish()`, which raises `NatsError(MaxPayloadExceeded)`
 * once the encoded length passes `info.max_payload`
 * (`nats-base-client/msg.js` -> `protocol.js`). The old code let that throw
 * escape to `processNatsSubscriptionMessage`, whose catch logged the generic
 * "NATS context-pack bridge request failed" and published NOTHING — so the
 * caller waited out its own timeout with no client-visible reason. A measured
 * live case built a 58.5 MB reply against a broker advertising 8 MiB.
 *
 * `respond()` returns false in exactly ONE case: the request carried no reply
 * inbox at all. That condition is real but unrelated to size, which is why the
 * "no reply inbox" reading is kept for it and only for it, below.
 *
 * The answer is an error envelope, never silence. Three paths reach it:
 *   (a) the encoded reply exceeds the broker's OWN advertised figure, which we
 *       compare against BEFORE publishing so we never spend a doomed publish;
 *   (b) the publish THROWS `MaxPayloadExceeded` anyway — the advertised figure
 *       was unreadable, so the reply was never pre-judged and the broker's own
 *       client rejected it. Matched by error CODE, never by message text, so a
 *       reworded client string cannot silently reopen the defect. Any other
 *       throw is not ours to interpret and is rethrown unchanged;
 *   (c) `respond()` returns false — no reply inbox. We answer with the same
 *       envelope, and if that is refused too the reading below is accurate.
 *
 * The error envelope is CONTENT-FREE: it names what happened, the measured
 * reply bytes, the broker's advertised figure, and which sections were asked
 * for. No pack data crosses into it, so an undeliverable reply cannot leak
 * through the error path.
 *
 * This changes only how an undeliverable reply is ANSWERED. What the handler
 * builds is untouched — the pack is still built in full, and nothing here
 * reshapes, shortens, or withholds any part of it.
 *
 * If the error envelope ITSELF cannot be published there is nothing further the
 * bridge can do on the wire, so it logs accurately and gives up — that case is
 * a genuinely missing reply inbox.
 */
async function respondWithinBrokerFigure(
  message: NatsRequestMessage,
  response: FleetEnvelope,
): Promise<NatsReplyResult> {
  const encoded = envelopeToBytes(response);
  const advertised = message.maxPayloadBytes;

  if (await tryPublishReply(message, encoded, advertised)) {
    return { outcome: "published" };
  }

  return publishUndeliverableReply(message, response, encoded.byteLength, advertised);
}

/**
 * Handle one delivered message end to end under a background trace: build the
 * response, publish it within the broker's figure, and record the outcome.
 */
async function traceHandledMessage(
  message: NatsRequestMessage,
  options: StartNatsContextPackBridgeOptions,
  health: NatsBridgeHealth,
): Promise<void> {
  const traceStart = {
    name: "nats.message",
    input: { subject: message.subject, bytes: message.data.byteLength },
    tags: ["open-brain-server", "background-job", "nats"],
    metadata: {
      subject: message.subject,
      ...(hasDeclaredSessionKey(message.data)
        ? { declared_session_key_unverified: "[MASKED:unverified]" }
        : {}),
    },
    sessionId: undefined as string | undefined,
  };
  const trace = new BackgroundTraceRecorder(options.tracing, traceStart);
  try {
    const response = await trace.span(
      "nats.handle",
      () =>
        handleNatsContextPackMessage({
          message,
          boundary: options.boundary,
          tokenMap: options.tokenMap,
          deps: options.deps,
          health,
          onResolvedBinding: (binding) => {
            traceStart.sessionId = binding.sessionId;
          },
        }),
      {
        input: { subject: message.subject },
        output: (value) => ({
          outcome: responseOutcome(value),
          correlation_id: value.correlation_id ?? null,
        }),
      },
    );
    const reply = await trace.span(
      "nats.reply",
      () => respondWithinBrokerFigure(message, response),
      {
        input: { subject: message.subject },
        output: (value) => value,
      },
    );
    trace.finish({
      subject: message.subject,
      outcome: responseOutcome(response),
      reply_outcome: reply.outcome,
      ...(reply.error === undefined ? {} : { error: reply.error }),
    });
  } catch (error: unknown) {
    trace.fail(error);
    throw error;
  }
}

export async function startNatsContextPackBridge(
  options: StartNatsContextPackBridgeOptions,
): Promise<NatsBridgeRuntime | null> {
  if (
    options.boundary.requested_transport !== "nats" ||
    options.boundary.nats.availability !== "available"
  ) {
    return null;
  }

  const health = options.health ?? createNatsBridgeHealth("available");
  const driver =
    options.driver ?? (await createNatsJsDriver(options.boundary.nats.url, health));
  markNatsBridgeAvailable(health);
  const subject = options.boundary.nats.context_pack_subject;
  const subscription = await driver.subscribe(subject, (message) =>
    traceHandledMessage(message, options, health),
  );

  return {
    subject,
    availability: "available",
    health,
    close: async () => {
      markNatsBridgeUnavailable(health, "NATS bridge closed");
      const closeErrors: unknown[] = [];
      try {
        await subscription.close();
      } catch (err) {
        closeErrors.push(err);
      }
      try {
        await driver.close();
      } catch (err) {
        closeErrors.push(err);
      }
      if (closeErrors.length === 1) throw closeErrors[0];
      if (closeErrors.length > 1) {
        throw new AggregateError(closeErrors, "NATS bridge close failed");
      }
    },
  };
}
