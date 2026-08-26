/**
 * Live MCP session bookkeeping for `session-manager.ts`.
 *
 * Extracted from `session-manager.ts` (#780) so the handler module is left with
 * request/response shaping and this module owns the one thing every handler
 * shares: the map of live sessions and the rules for keeping an entry alive,
 * retiring it, and deciding whether a request is allowed to touch it.
 *
 * Nothing here reads or writes an Express request. The store is handed a
 * transport and an identity, and it hands back state -- which is what makes the
 * expiry and identity rules testable through the public handler surface without
 * a socket.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import type { AuthIdentity } from "../auth/types.ts";

export interface SessionIdentity extends AuthIdentity {
  readonly agentId?: string;
}

export interface SessionTransportConfig {
  readonly sessionTtlMs: number;
  readonly maxSessions: number;
  readonly retryAfterSeconds: number;
  readonly closeTimeoutMs: number;
  readonly sweepIntervalMs: number;
}

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  readonly identity: SessionIdentity;
  timer: ReturnType<typeof setTimeout>;
  lastActivity: number;
  inFlight: number;
}

/**
 * Two identities are the same session only when every auth-derived field
 * matches. Written as a table walk rather than a chain of `&&` so adding a
 * field is a one-line change and the comparison stays flat.
 */
const IDENTITY_FIELDS = [
  (identity: SessionIdentity) => identity.tokenClientId,
  (identity: SessionIdentity) => identity.role,
  (identity: SessionIdentity) => identity.clientId,
  (identity: SessionIdentity) => identity.namespaceSource,
  (identity: SessionIdentity) => identity.agentId ?? "",
] as const;

export function sameIdentity(
  left: SessionIdentity | undefined,
  right: SessionIdentity,
): boolean {
  if (!left) return false;
  return IDENTITY_FIELDS.every((read) => read(left) === read(right));
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private pendingInitializes = 0;

  constructor(
    private readonly config: SessionTransportConfig,
    private readonly logger: Logger,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  get pendingCount(): number {
    return this.pendingInitializes;
  }

  get activeCount(): number {
    return this.sessions.size + this.pendingInitializes;
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  beginInitialize(): void {
    this.pendingInitializes += 1;
  }

  endInitialize(): void {
    this.pendingInitializes = Math.max(0, this.pendingInitializes - 1);
  }

  admits(): boolean {
    return this.activeCount < this.config.maxSessions;
  }

  register(
    sessionId: string,
    transport: StreamableHTTPServerTransport,
    identity: SessionIdentity,
  ): void {
    const timer = setTimeout(() => {
      void this.expire(sessionId, "inactivity");
    }, this.config.sessionTtlMs);
    this.sessions.set(sessionId, {
      transport,
      identity,
      timer,
      lastActivity: Date.now(),
      inFlight: 0,
    });
    this.logger.info({ session_id: sessionId }, "session_initialized");
  }

  /** Drop an entry whose transport closed under us, without closing it again. */
  forget(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.sessions.delete(sessionId);
    this.logger.info({ session_id: sessionId }, "session_transport_closed");
  }

  armExpiry(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.lastActivity = Date.now();
    entry.timer = setTimeout(() => {
      void this.expire(sessionId, "inactivity");
    }, this.config.sessionTtlMs);
  }

  async expire(sessionId: string, reason: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.inFlight > 0) {
      this.logger.debug(
        { session_id: sessionId, reason },
        "session_expiry_deferred",
      );
      this.armExpiry(sessionId);
      return;
    }
    clearTimeout(entry.timer);
    this.sessions.delete(sessionId);
    await this.closeTransport(entry.transport, sessionId, reason);
  }

  async closeTransport(
    transport: StreamableHTTPServerTransport,
    sessionId: string,
    reason: string,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.close(),
        new Promise<void>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("session_transport_close_timeout")),
            this.config.closeTimeoutMs,
          );
          timeout.unref();
        }),
      ]);
      this.logger.info({ session_id: sessionId, reason }, "session_closed");
    } catch (error: unknown) {
      this.logger.warn(
        {
          session_id: sessionId,
          reason,
          error_category: error instanceof Error ? error.name : typeof error,
        },
        "session_close_failed",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** Run `work` with the session marked busy, so idle expiry cannot land mid-request. */
  async runWithSession(
    sessionId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      await work();
      return;
    }
    entry.inFlight += 1;
    try {
      await work();
    } finally {
      const current = this.sessions.get(sessionId);
      if (current) {
        current.inFlight = Math.max(0, current.inFlight - 1);
        this.armExpiry(sessionId);
      }
    }
  }

  /** Retire every entry idle for more than twice the TTL; returns how many were swept. */
  sweep(): number {
    const now = Date.now();
    let swept = 0;
    for (const [sessionId, entry] of this.sessions) {
      if (entry.inFlight > 0) continue;
      if (now - entry.lastActivity <= this.config.sessionTtlMs * 2) continue;
      swept += 1;
      void this.expire(sessionId, "sweeper");
    }
    return swept;
  }
}
