/**
 * Barrel for the hand-maintained tool-contract mirror.
 *
 * The declarations were one 1671-line module at `src/contract-schemas.ts`;
 * issue 864 split them by tool group into the sibling `schemas-*.ts` files and
 * re-joins them here, so `TOOL_CONTRACTS` presents the identical surface and
 * the contract hash is unchanged.
 */
import { AGENT_TOOL_CONTRACTS } from "./schemas-agent-surface.ts";
import { EVENT_TOOL_CONTRACTS } from "./schemas-events.ts";
import { RECALL_TOOL_CONTRACTS } from "./schemas-recall.ts";
import { REPO_FACT_TOOL_CONTRACTS } from "./schemas-repo-facts.ts";
import { SESSION_TOOL_CONTRACTS } from "./schemas-session.ts";
import type { ToolContract } from "./tool-contract.ts";

export type { ToolContract };
export {
  AGENT_TOOL_CONTRACTS,
  EVENT_TOOL_CONTRACTS,
  RECALL_TOOL_CONTRACTS,
  REPO_FACT_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
};

export const TOOL_CONTRACTS: Record<string, ToolContract> = {
  ...AGENT_TOOL_CONTRACTS,
  ...RECALL_TOOL_CONTRACTS,
  ...SESSION_TOOL_CONTRACTS,
  ...EVENT_TOOL_CONTRACTS,
  ...REPO_FACT_TOOL_CONTRACTS,
};
