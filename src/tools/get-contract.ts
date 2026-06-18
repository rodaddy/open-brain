import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo } from "../types.ts";
import { buildContract } from "../contract.ts";
import type { ToolDeps } from "./index.ts";

export function registerGetContract(server: McpServer, _deps: ToolDeps): void {
  server.registerTool(
    "get_contract",
    {
      description:
        "Return the canonical Open Brain public contract manifest for downstream clients.",
      inputSchema: {},
      annotations: {
        title: "Get Contract",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (_args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canRead(auth.role, "sessions")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot read contract",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(buildContract()),
          },
        ],
      };
    },
  );
}
