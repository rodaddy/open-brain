/**
 * Namespace-denial guard for tools whose bodies belong to a later wave.
 *
 * `search_brain` is owned by the search lane, not the memory-tools wave, but its
 * namespace denial is a security boundary that the parity net freezes NOW
 * (`contracts/server/server-namespace-denial.fixture.json`). Registering only
 * the guard keeps that boundary observable and testable while making the
 * missing body explicit rather than silently absent — a tool that answers
 * queries with plausible-looking empty results would be worse than one that
 * says it is not implemented.
 *
 * Observed current-src denial string: `src/tools/search-brain.ts:1619`. It is
 * deliberately generic — unlike the session surfaces it does NOT echo the
 * requested namespace back, so a caller cannot probe which namespaces exist.
 *
 * The search lane replaces this whole file when it lands.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authIdentity, errorResult, type MemoryToolDependencies } from "./types.ts";
import { authorize } from "./memory-helpers.ts";

const NOT_IN_THIS_WAVE =
  "search_brain body is owned by the search lane and is not implemented in the memory-tools wave";

export function registerNamespaceGuardTool(
  server: McpServer,
  _dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "search_brain",
    {
      description: "Validate namespace access for semantic brain search",
      inputSchema: {
        query: z.string().min(1),
        namespace: z.string().max(500).optional(),
      },
      annotations: {
        title: "Search Brain",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "read",
        "thoughts",
        "namespace read access denied",
        args.namespace,
      );
      // Both the permission and the namespace arm collapse to one generic
      // string here, so denial never reveals whether the namespace exists.
      if (!auth.ok) return errorResult("Permission denied: namespace read access denied");
      return errorResult(NOT_IN_THIS_WAVE);
    },
  );
}
