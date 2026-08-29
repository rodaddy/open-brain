import type { AuthInfo } from "../types.ts";
import type { BackgroundTraceEmitter } from "./background-tracing.ts";
import type { ToolDeps } from "../../src/tools/index.ts";
import type { NamespaceSource, NatsRuntimeBoundary } from "./nats-runtime.ts";

export interface NatsRequestMessage {
  subject: string;
  data: Uint8Array;
  headers?: Record<string, string | undefined>;
  /**
   * The broker's OWN advertised payload figure for this connection, in bytes,
   * as reported by the server in its INFO (`connection.info.max_payload`).
   *
   * REPO LAW for this seam: never substitute a constant of our own here. The
   * figure differs per broker (this fleet's local broker advertises 8 MiB; the
   * NATS protocol default is 1 MiB), so a hardcoded number would either refuse
   * replies the broker would have carried or keep letting undeliverable ones
   * through. `undefined` means the driver could not read it — in that case the
   * bridge does not pre-judge the reply and simply publishes.
   */
  maxPayloadBytes?: number;
  respond(data: Uint8Array): boolean | void | Promise<boolean | void>;
}

export interface NatsSubscriptionHandle {
  close(): Promise<void> | void;
}

export interface NatsBridgeDriver {
  /**
   * Deliver messages under the driver's native acknowledgement contract.
   * A resolved handler means processing completed. A rejected handler must
   * propagate unchanged: the driver must not synthesize an acknowledgement or
   * swallow the rejection, so broker-native error/redelivery behavior remains
   * authoritative.
   */
  subscribe(
    subject: string,
    handler: (message: NatsRequestMessage) => Promise<void>,
  ): Promise<NatsSubscriptionHandle>;
  close(): Promise<void> | void;
}

export interface NatsBridgeRuntime {
  subject: string;
  availability: "available";
  health: NatsBridgeHealth;
  close(): Promise<void>;
}

export interface NatsBridgeHealth {
  availability: "available" | "not_runtime_available";
  consecutiveFailures: number;
  lastError: string | null;
}

export interface NatsSubscriptionHeaders {
  keys(): string[];
  get(key: string): string;
}

export interface NatsSubscriptionMessage {
  subject: string;
  data: Uint8Array;
  headers?: NatsSubscriptionHeaders;
  respond(data: Uint8Array): boolean | void | Promise<boolean | void>;
}

export interface StartNatsContextPackBridgeOptions {
  boundary: NatsRuntimeBoundary;
  tokenMap: Map<string, AuthInfo>;
  deps: ToolDeps;
  driver?: NatsBridgeDriver;
  health?: NatsBridgeHealth;
  tracing?: BackgroundTraceEmitter;
}

export interface LaneBinding {
  auth: AuthInfo;
  namespaceSource: NamespaceSource;
  sessionId: string;
}

export const MAX_NATS_REQUEST_BYTES = 64 * 1024;
export const NATS_RESUBSCRIBE_INITIAL_DELAY_MS = 25;
export const NATS_RESUBSCRIBE_MAX_DELAY_MS = 1_000;
export const NATS_EMPTY_SUBSCRIPTION_DEGRADE_THRESHOLD = 2;

// NamespaceSource (the response-contract type) is owned by nats-runtime.ts; keep
// a re-export so existing importers of it from this module still resolve.
export type { NamespaceSource } from "./nats-runtime.ts";
