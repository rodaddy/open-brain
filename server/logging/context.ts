/**
 * Async operation correlation context.
 *
 * Design authority: `_DOCS/STANDARDS-observability.md` requires correlation IDs
 * across await boundaries; AsyncLocalStorage owns that propagation here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface CorrelationContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Return the active correlation identifier, or the boot-safe system value. */
export function correlationId(): string {
  return storage.getStore()?.correlationId ?? "system";
}

/** Run asynchronous work inside one correlation scope. */
export function withCorrelation<T>(
  work: () => T,
  requestedCorrelationId: string = randomUUID(),
): T {
  return storage.run({ correlationId: requestedCorrelationId }, work);
}
