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

/** The injected recovery WAL store, or the shared process-lifetime fallback. */
export function recoveryWalStoreFor(
  dependencies: MemoryToolDependencies,
): RecoveryWalStore {
  if (dependencies.recoveryWalStore) return dependencies.recoveryWalStore;
  fallbackRecoveryWalStore ??= new RecoveryWalStore({
    walPath: process.env.OPENBRAIN_RECOVERY_WAL_PATH ?? null,
    logger: dependencies.logger,
  });
  return fallbackRecoveryWalStore;
}
