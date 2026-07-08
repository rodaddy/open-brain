import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "../types.ts";
import { canReadDoctor, getOperatorDoctorStatus } from "../operator-doctor.ts";
import { readNatsRuntimeBoundary } from "../nats-runtime.ts";
import type { ToolDeps } from "./index.ts";

export function registerOperatorDoctor(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "operator_doctor",
    {
      description:
        "Return privileged operator doctor/status JSON without secrets or raw paths.",
      inputSchema: {},
      annotations: {
        title: "Operator Doctor",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (_args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!canReadDoctor(auth)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: admin or ob-admin role required",
            },
          ],
          isError: true,
        };
      }

      try {
        const status = await getOperatorDoctorStatus(
          deps.pool,
          deps.natsRuntimeBoundary ?? readNatsRuntimeBoundary(process.env),
          deps.natsBridgeHealth,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(status),
            },
          ],
        };
      } catch {
        // Never surface raw error messages (they can carry paths or env
        // detail) through MCP tool error text.
        return {
          content: [
            {
              type: "text" as const,
              text: "operator doctor status unavailable",
            },
          ],
          isError: true,
        };
      }
    },
  );
}
