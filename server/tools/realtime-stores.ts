/**
 * The single resolution point for the two process-lifetime realtime stores.
 *
 * Design authority: `docs/decisions/realtime-working-set.md` (RAM-only working
 * context) as exercised by
 * `contracts/server/server-realtime-working-recovery.fixture.json` and
 * `contracts/server/server-context-pack-sections.fixture.json`.
 *
 * This module exists because the realtime surface has TWO halves that must see
 * the SAME object: `working_set_append`/`recovery_wal_append`/`recovery_wal_mark`
 * write, and `agent_context_pack`'s `working_set`/`recovery` sections read. When
 * a composition root injects no store, each half needs a fallback — and if each
 * half owned its own fallback, an append would land in one map while the pack
 * read an empty one, and the pack would report a permanent, entirely convincing
 * zero for content that was accepted moments earlier. Nothing persists this
 * state, so no database check would ever contradict the wrong answer.
 *
 * The fallbacks are therefore MODULE-scoped and shared, for the same reason the
 * injected stores are process-lifetime: a store rebuilt per call is empty on
 * every request.
 */
import { RecoveryWalStore } from "../realtime/recovery-wal.ts";
import { WorkingSetStore } from "../realtime/working-set.ts";
import type { MemoryToolDependencies } from "./types.ts";

let fallbackWorkingSetStore: WorkingSetStore | undefined;
let fallbackRecoveryWalStore: RecoveryWalStore | undefined;
/** The `recoveryWalPath` the current fallback was built for. */
let fallbackRecoveryWalPath: string | null | undefined;

/** The injected working-set store, or the shared process-lifetime fallback. */
export function workingSetStoreFor(
  dependencies: MemoryToolDependencies,
): WorkingSetStore {
  if (dependencies.workingSetStore) return dependencies.workingSetStore;
  fallbackWorkingSetStore ??= new WorkingSetStore({
    logger: dependencies.logger,
  });
  return fallbackWorkingSetStore;
}

/**
 * The injected recovery WAL store, or the shared process-lifetime fallback.
 *
 * The fallback is keyed on the `recoveryWalPath` it was built for, so an
 * injected path is honored no matter WHEN it arrives: callers asking for the
 * same path keep sharing one store — which is the point of a process-lifetime
 * fallback — and a caller asking for a different path (or for none) gets a
 * store built for that path instead of silently writing to the first one seen.
 * Memoizing on first touch alone made the answer depend on registration order,
 * which is invisible in a single-file run and wrong in a whole-suite one.
 */
export function recoveryWalStoreFor(
  dependencies: MemoryToolDependencies,
): RecoveryWalStore {
  if (dependencies.recoveryWalStore) return dependencies.recoveryWalStore;
  const walPath = dependencies.recoveryWalPath ?? null;
  if (!fallbackRecoveryWalStore || fallbackRecoveryWalPath !== walPath) {
    fallbackRecoveryWalStore = new RecoveryWalStore({
      walPath,
      logger: dependencies.logger,
    });
    fallbackRecoveryWalPath = walPath;
  }
  return fallbackRecoveryWalStore;
}
