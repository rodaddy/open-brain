// L5 shim (issue 864): re-export over server/tools/context-pack-durable-memory.ts; retired with src/ at L6.
//
// This file carried a legacy 5-argument positional `loadDurableMemoryContext`
// wrapper over the server twin's single-request form. Nothing in the repo called
// it: the only consumers, the
// src/tools/__tests__/agent-context-pack-durable-memory-*.test.ts suites,
// black-box the section through the MCP tool, and server/tools/context-pack-loaders.ts
// calls the server twin directly. An adapter earns its code by keeping a call
// form somebody still uses, so with no caller the wrapper was dead and the file
// is a plain re-export.
export {
  DURABLE_MEMORY_BURST_ITEMS,
  recordCitationId,
  recordSourceRef,
  recordStructuralSourceRef,
} from "../../server/tools/context-pack-durable-memory.ts";
export type { DurableMemoryContextFragment } from "../../server/tools/context-pack-durable-memory.ts";
