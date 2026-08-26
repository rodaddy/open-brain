import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import type { Pool } from "pg";
import type { AuthIdentity } from "../auth/types.ts";
import type { NatsRuntimeBoundary } from "../../src/nats-runtime.ts";
import type { FtsConfig } from "./fts-config.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";
import type { WorkingSetStore } from "../realtime/working-set.ts";
import type { RecoveryWalStore } from "../realtime/recovery-wal.ts";

export interface MemoryToolDependencies {
  readonly pool: Pool;
  readonly embedFn: (text: string) => Promise<number[] | null>;
  readonly logger: Logger;
  readonly embeddingModel?: string;
  /**
   * Validated shared-namespace names from the composition root.
   *
   * Absent means the helpers in `./shared-namespace.ts` derive them from the
   * environment as they always have; present means this one parse is in force.
   */
  readonly sharedNamespaceNames?: SharedNamespaceConfig;
  /**
   * Resolved qmd entry point for `search_all`'s file-index arm.
   *
   * Injected so a test can federate against a stub without spawning anything,
   * and so the resolution rule lives at the composition root rather than being
   * re-derived inside a handler. Absent means qmd federation is off, and
   * `search_all` says so in its log rather than quietly returning brain-only
   * results (`docs/qmd-ob-layered-recall.md` records the silent-degradation
   * defect this avoids).
   */
  readonly qmdPath?: string;
  /**
   * Process-lifetime realtime stores backing the context pack's `working_set`
   * and `recovery` sections.
   *
   * Injected rather than constructed per call, because both are STATEFUL: the
   * working set is RAM-only scratch for the active turn, and the recovery WAL
   * holds a crashed session's quarantined trace. A store built inside a handler
   * would start empty on every request, so both sections would report a
   * permanent, extremely convincing zero.
   *
   * Optional so a caller that registers no realtime surface pays nothing; the
   * pack then reports the defined empty envelopes from a default store rather
   * than failing.
   */
  readonly workingSetStore?: WorkingSetStore;
  readonly recoveryWalStore?: RecoveryWalStore;
  /**
   * Deployment-wide corpus default for full-text search.
   *
   * From `config.fts.corpusConfig`. Absent means english, which is what
   * `corpusFtsConfig` answered for an unset environment.
   */
  readonly ftsCorpusConfig?: FtsConfig;
  /**
   * Recovery WAL path for the fallback store, `null` for RAM-only.
   *
   * From `config.recovery.walPath`. Only consulted when no `recoveryWalStore`
   * was injected; a composition root that builds the store itself has already
   * applied this value and never reaches the fallback.
   */
  readonly recoveryWalPath?: string | null;
  /**
   * The NATS runtime boundary `operator_doctor` reports.
   *
   * From `natsRuntimeBoundaryFromConfig(config.nats)`. Absent means the doctor
   * reports the boundary an unset environment produces — an http transport that
   * requested no bridge — rather than reading the environment a second time.
   */
  readonly natsRuntimeBoundary?: NatsRuntimeBoundary;
  /**
   * Milliseconds the query-embedding call may take before a search degrades.
   *
   * From `config.search.embeddingTimeoutMs`. Absent means the search engine's
   * own default answers — the value an unset environment produced when the
   * engine read the environment itself.
   */
  readonly searchEmbeddingTimeoutMs?: number;
}

export interface McpAuthInfo {
  readonly role: AuthIdentity["role"];
  readonly clientId: string;
  readonly tokenClientId?: string;
  readonly agentId?: string;
  readonly namespaceSource?: "token" | "header" | "delegated";
}

export type MemoryToolRegistrar = (
  server: McpServer,
  dependencies: MemoryToolDependencies,
) => void;

export function authIdentity(value: unknown): AuthIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const auth = value as Partial<McpAuthInfo>;
  if (!auth.role || !auth.clientId) return undefined;
  return {
    role: auth.role,
    clientId: auth.clientId,
    tokenClientId: auth.tokenClientId ?? auth.clientId,
    namespaceSource:
      auth.namespaceSource === "header" || auth.namespaceSource === "delegated"
        ? "delegated"
        : "token",
  };
}

export function textResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

export function errorResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { ...textResult(text), isError: true };
}
