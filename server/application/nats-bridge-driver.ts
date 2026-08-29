import type {
  NatsBridgeDriver,
  NatsBridgeHealth,
  NatsRequestMessage,
  NatsSubscriptionHeaders,
  NatsSubscriptionMessage,
} from "./nats-bridge-types.ts";
import {
  NATS_EMPTY_SUBSCRIPTION_DEGRADE_THRESHOLD,
  NATS_RESUBSCRIBE_INITIAL_DELAY_MS,
  NATS_RESUBSCRIBE_MAX_DELAY_MS,
} from "./nats-bridge-types.ts";
import {
  errorMessage,
  logNatsHandlerError,
  logNatsSubscriptionError,
} from "./nats-bridge-envelope.ts";

export function nextNatsResubscribeDelay(currentMs: number): number {
  return Math.min(currentMs * 2, NATS_RESUBSCRIBE_MAX_DELAY_MS);
}

export function markNatsBridgeAvailable(health: NatsBridgeHealth): void {
  health.availability = "available";
  health.consecutiveFailures = 0;
  health.lastError = null;
}

export function markNatsBridgeUnavailable(
  health: NatsBridgeHealth,
  message: string,
): void {
  health.availability = "not_runtime_available";
  health.consecutiveFailures += 1;
  health.lastError = message;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processNatsSubscriptionMessage(
  message: NatsSubscriptionMessage,
  handler: (message: NatsRequestMessage) => Promise<void>,
  maxPayloadBytes?: number,
  onError: (err: unknown, subject: string) => void = logNatsHandlerError,
): Promise<void> {
  try {
    await handler({
      subject: message.subject,
      data: message.data,
      headers: headersToRecord(message.headers),
      maxPayloadBytes,
      respond: (data) => {
        return message.respond(data);
      },
    });
  } catch (err) {
    onError(err, message.subject);
  }
}

/**
 * The broker's own advertised payload figure for this connection, in bytes.
 *
 * Sourced ONLY from the server's INFO (`connection.info.max_payload`) — the
 * bridge never supplies a figure of its own, because the correct value is
 * whatever THIS broker says it is and that differs between deployments. A
 * connection that has not yet reported INFO returns undefined, and the reply is
 * published without being pre-judged.
 */
function advertisedMaxPayloadBytes(connection: {
  info?: { max_payload?: number };
}): number | undefined {
  const advertised = connection.info?.max_payload;
  return typeof advertised === "number" && Number.isFinite(advertised) && advertised > 0
    ? advertised
    : undefined;
}

function headersToRecord(
  headers: NatsSubscriptionHeaders | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const record: Record<string, string> = {};
  for (const key of headers.keys()) {
    record[key] = headers.get(key);
  }
  return record;
}

interface NatsSubscriptionLike extends AsyncIterable<NatsSubscriptionMessage> {
  unsubscribe(): void;
}

interface NatsConnectionLike {
  info?: { max_payload?: number };
  subscribe(subject: string): NatsSubscriptionLike;
  drain(): Promise<void>;
}

/**
 * Mutable state of ONE resubscribe loop, held in an object so the loop's steps
 * can be named helpers instead of one long body. Nothing here crosses
 * subscriptions: each `subscribe()` call gets its own.
 */
interface ResubscribeState {
  /** Fixed collaborators of this one loop, set once at subscribe time. */
  readonly connection: NatsConnectionLike;
  readonly subject: string;
  readonly handler: (message: NatsRequestMessage) => Promise<void>;
  readonly health: NatsBridgeHealth;
  subscription: NatsSubscriptionLike;
  closed: boolean;
  resubscribeDelayMs: number;
  needsSubscription: boolean;
  consecutiveEmptySubscriptions: number;
}

/**
 * Re-open the subscription when the previous one ended. Returns false when the
 * re-open itself failed, in which case the caller backs off and retries.
 */
async function reopenSubscription(state: ResubscribeState): Promise<boolean> {
  try {
    state.subscription = state.connection.subscribe(state.subject);
    state.needsSubscription = false;
    return true;
  } catch (err) {
    markNatsBridgeUnavailable(state.health, errorMessage(err));
    logNatsSubscriptionError(err, state.subject);
    state.resubscribeDelayMs = nextNatsResubscribeDelay(state.resubscribeDelayMs);
    await delay(state.resubscribeDelayMs);
    return false;
  }
}

/**
 * Drain the current subscription. Returns whether any message was processed:
 * an iterator that ends without delivering anything is the "empty subscription
 * churn" signal the health state degrades on.
 */
async function drainSubscription(state: ResubscribeState): Promise<boolean> {
  let processedMessage = false;
  for await (const message of state.subscription) {
    if (state.closed) break;
    processedMessage = true;
    state.consecutiveEmptySubscriptions = 0;
    markNatsBridgeAvailable(state.health);
    state.resubscribeDelayMs = NATS_RESUBSCRIBE_INITIAL_DELAY_MS;
    await processNatsSubscriptionMessage(
      message,
      state.handler,
      // Read the figure PER MESSAGE, not once at connect: nats.js
      // refreshes `connection.info` on reconnect, so a failover to a
      // broker advertising a different figure is picked up here
      // instead of being judged against a stale one.
      advertisedMaxPayloadBytes(state.connection),
    );
  }
  return processedMessage;
}

function noteEmptySubscription(state: ResubscribeState): void {
  state.consecutiveEmptySubscriptions += 1;
  if (
    state.consecutiveEmptySubscriptions >= NATS_EMPTY_SUBSCRIPTION_DEGRADE_THRESHOLD
  ) {
    markNatsBridgeUnavailable(state.health, "NATS subscription ended without messages");
  }
}

/**
 * Drain once and report whether a message was seen, recording a drain that
 * threw as a subscription failure. Returns false on the failure path, which is
 * what makes the caller back off before re-opening.
 */
async function drainOnce(state: ResubscribeState): Promise<boolean> {
  try {
    const processedMessage = await drainSubscription(state);
    if (!state.closed && !processedMessage) noteEmptySubscription(state);
    return processedMessage;
  } catch (err) {
    if (!state.closed) {
      state.consecutiveEmptySubscriptions = 0;
      markNatsBridgeUnavailable(state.health, errorMessage(err));
      logNatsSubscriptionError(err, state.subject);
    }
    return false;
  }
}

async function runResubscribeLoop(state: ResubscribeState): Promise<void> {
  while (!state.closed) {
    if (state.needsSubscription) {
      const reopened = await reopenSubscription(state);
      if (!reopened) continue;
    }

    const processedMessage = await drainOnce(state);
    state.needsSubscription = true;
    if (!state.closed && !processedMessage) {
      state.resubscribeDelayMs = nextNatsResubscribeDelay(state.resubscribeDelayMs);
    }

    if (!state.closed) {
      await delay(state.resubscribeDelayMs);
    }
  }
}

export async function createNatsJsDriver(
  url: string | null,
  health: NatsBridgeHealth,
): Promise<NatsBridgeDriver> {
  if (!url) {
    throw new Error("OPENBRAIN_NATS_URL is required when NATS bridge is enabled");
  }

  const nats = await import("nats");
  const connection = (await nats.connect({
    servers: url,
  })) as unknown as NatsConnectionLike;

  return {
    subscribe: async (subject, handler) => {
      const state: ResubscribeState = {
        connection,
        subject,
        handler,
        health,
        subscription: connection.subscribe(subject),
        closed: false,
        resubscribeDelayMs: NATS_RESUBSCRIBE_INITIAL_DELAY_MS,
        needsSubscription: false,
        consecutiveEmptySubscriptions: 0,
      };

      void runResubscribeLoop(state);

      return {
        close: () => {
          state.closed = true;
          markNatsBridgeUnavailable(health, "NATS bridge closed");
          state.subscription.unsubscribe();
        },
      };
    },
    close: async () => {
      await connection.drain();
    },
  };
}
