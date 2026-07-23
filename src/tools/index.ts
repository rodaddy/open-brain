import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import type { generateEmbedding } from "../embedding.ts";
import type { NatsBridgeHealth } from "../nats-bridge.ts";
import type { NatsRuntimeBoundary } from "../nats-runtime.ts";
import { registerLogThought } from "./log-thought.ts";
import { registerLogDecision } from "./log-decision.ts";
import { registerSearchBrain } from "./search-brain.ts";
import { registerFindPerson } from "./find-person.ts";
import { registerSessionSave } from "./session-save.ts";
import { registerSessionLoad } from "./session-load.ts";
import { registerArchiveEntry } from "./archive-entry.ts";
import { registerListRecent } from "./list-recent.ts";
import { registerListStale } from "./list-stale.ts";
import { registerUpdateEntry } from "./update-entry.ts";
import { registerRateEntry } from "./rate-entry.ts";
import { registerSearchAll } from "./search-all.ts";
import { registerBrainAnswer } from "./brain-answer.ts";
import { registerUpsertPerson } from "./upsert-person.ts";
import { registerSetTier } from "./set-tier.ts";
import { registerGetEntry } from "./get-entry.ts";
import { registerDecomposeEntry } from "./decompose-entry.ts";
import { registerResolveEntry } from "./resolve-entry.ts";
import { registerGetStats } from "./get-stats.ts";
import { registerAccessReport } from "./access-report.ts";
import { registerBulkSetTier } from "./bulk-set-tier.ts";
import { registerFindDuplicates } from "./find-duplicates.ts";
import { registerCurateEntries } from "./curate-entries.ts";
import { registerBulkArchive } from "./bulk-archive.ts";
import { registerListNamespaces } from "./list-namespaces.ts";
import { registerTierRecommendations } from "./tier-recommendations.ts";
import { registerLaneUpsert } from "./lane-upsert.ts";
import { registerLaneLoad } from "./lane-load.ts";
import { registerAppendSessionEvent } from "./append-session-event.ts";
import { registerCitationRecall } from "./citation-recall.ts";
import { registerSessionContext } from "./session-context.ts";
import { registerSessionStart } from "./session-start.ts";
import { registerSessionWrap } from "./session-wrap.ts";
import { registerUpsertEntity } from "./upsert-entity.ts";
import { registerArchiveEntity } from "./archive-entity.ts";
import { registerGetEntity } from "./get-entity.ts";
import { registerHydrateEntities } from "./hydrate-entities.ts";
import { registerListEntities } from "./list-entities.ts";
import { registerLinkEntities } from "./link-entities.ts";
import { registerUnlinkEntities } from "./unlink-entities.ts";
import { registerAdjacentContext } from "./adjacent-context.ts";
import { registerPromoteEntry } from "./promote-entry.ts";
import { registerDemoteEntry } from "./demote-entry.ts";
import { registerScanNamespace } from "./scan-namespace.ts";
import { registerTierLane } from "./tier-lane.ts";
import { registerPromoteShared } from "./promote-shared.ts";
import { registerGetContract } from "./get-contract.ts";
import { registerOperatorDoctor } from "./operator-doctor.ts";
import { registerListRepoFacts, registerUpsertRepoFact } from "./repo-facts.ts";
import { registerSourceRegistry } from "./source-registry.ts";
import { registerIngestConversationFacts } from "./ingest-conversation-facts.ts";
import {
  registerAgentContextPack,
  registerAgentReflexPointers,
  registerRecoveryWalAppend,
  registerRecoveryWalMark,
  registerWorkingSetAppend,
} from "./agent-context-pack.ts";
import { WorkingSetStore } from "../realtime/working-set.ts";
import { RecoveryWalStore } from "../realtime/recovery-wal.ts";
import { installMcpAudit, type McpAuditConfig } from "../audit-log.ts";

export interface ToolDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
  allowNonTransactionalAppendFallback?: boolean;
  workingSetStore?: WorkingSetStore;
  recoveryWalStore?: RecoveryWalStore;
  natsRuntimeBoundary?: NatsRuntimeBoundary;
  natsBridgeHealth?: NatsBridgeHealth;
  mcpAuditConfig?: McpAuditConfig;
}

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  const toolDeps: ToolDeps = {
    ...deps,
    workingSetStore: deps.workingSetStore ?? new WorkingSetStore(),
    recoveryWalStore:
      deps.recoveryWalStore ??
      new RecoveryWalStore({
        walPath: process.env.OPENBRAIN_RECOVERY_WAL_PATH ?? null,
      }),
  };

  installMcpAudit(server, {
    pool: toolDeps.pool,
    config: toolDeps.mcpAuditConfig,
  });

  registerLogThought(server, toolDeps);
  registerLogDecision(server, toolDeps);
  registerSearchBrain(server, toolDeps);
  registerFindPerson(server, toolDeps);
  registerSessionSave(server, toolDeps);
  registerSessionLoad(server, toolDeps);
  registerArchiveEntry(server, toolDeps);
  registerListRecent(server, toolDeps);
  registerListStale(server, toolDeps);
  registerUpdateEntry(server, toolDeps);
  registerRateEntry(server, toolDeps);
  registerSearchAll(server, toolDeps);
  registerBrainAnswer(server, toolDeps);
  registerUpsertPerson(server, toolDeps);
  registerSetTier(server, toolDeps);
  registerGetEntry(server, toolDeps);
  registerDecomposeEntry(server, toolDeps);
  registerResolveEntry(server, toolDeps);
  registerGetStats(server, toolDeps);
  registerAccessReport(server, toolDeps);
  registerBulkSetTier(server, toolDeps);
  registerFindDuplicates(server, toolDeps);
  registerCurateEntries(server, toolDeps);
  registerBulkArchive(server, toolDeps);
  registerListNamespaces(server, toolDeps);
  registerTierRecommendations(server, toolDeps);
  registerLaneUpsert(server, toolDeps);
  registerLaneLoad(server, toolDeps);
  registerAppendSessionEvent(server, toolDeps);
  registerCitationRecall(server, toolDeps);
  registerSessionContext(server, toolDeps);
  registerSessionStart(server, toolDeps);
  registerSessionWrap(server, toolDeps);
  registerUpsertEntity(server, toolDeps);
  registerArchiveEntity(server, toolDeps);
  registerGetEntity(server, toolDeps);
  registerHydrateEntities(server, toolDeps);
  registerListEntities(server, toolDeps);
  registerLinkEntities(server, toolDeps);
  registerUnlinkEntities(server, toolDeps);
  registerAdjacentContext(server, toolDeps);
  registerPromoteEntry(server, toolDeps);
  registerDemoteEntry(server, toolDeps);
  registerScanNamespace(server, toolDeps);
  registerTierLane(server, toolDeps);
  registerPromoteShared(server, toolDeps);
  registerWorkingSetAppend(server, toolDeps);
  registerRecoveryWalAppend(server, toolDeps);
  registerRecoveryWalMark(server, toolDeps);
  registerAgentContextPack(server, toolDeps);
  registerAgentReflexPointers(server, toolDeps);
  registerGetContract(server, toolDeps);
  registerOperatorDoctor(server, toolDeps);
  registerUpsertRepoFact(server, toolDeps);
  registerListRepoFacts(server, toolDeps);
  registerSourceRegistry(server, toolDeps);
  registerIngestConversationFacts(server, toolDeps);
}
