/**
 * `operator_doctor`: privileged diagnostics, without secrets or raw paths.
 *
 * The status payload is produced by `src/operator-doctor.ts` rather than
 * rebuilt here, for the same reason `get_contract` reuses `buildContract`: the
 * shape is a FROZEN contract. `src/operator-doctor.test.ts` locks the exact key
 * set of every section against `DOCTOR_CONTRACT_VERSION`
 * (`2026-08-05.operator-doctor.v4`), so a second implementation in the rewrite
 * would be a second payload that the lock test does not police, free to drift
 * on the first field addition. Reusing the builder keeps one answer to "how is
 * this server doing" and keeps that answer under the existing lock.
 *
 * The builder is a pure function of `(pool, natsRuntimeBoundary,
 * natsBridgeHealth)`. The rewrite has not ported `nats-runtime.ts`, so the
 * boundary is read from the environment exactly as current-src's tool does when
 * no boundary was injected -- that path opens no NATS connection, it only reads
 * `OPENBRAIN_TRANSPORT`/`OPENBRAIN_NATS_URL` and reports what they declare.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   - The role gate is admin/ob-admin ONLY, and it is not the ordinary
 *     `canRead` table check. Doctor output describes the deployment (migration
 *     state, provider reachability, pool health), which is operator
 *     information, not namespaced memory, so no namespace predicate applies and
 *     no lesser role may read it.
 *   - A thrown error returns a FIXED string. Raw error text here can carry
 *     filesystem paths or environment detail, so the reason goes to the log and
 *     the caller gets a constant -- the diagnostic surface is exactly where a
 *     leak would be least noticed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOperatorDoctorStatus } from "../../src/operator-doctor.ts";
import { readNatsRuntimeBoundary } from "../../src/nats-runtime.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";

export function registerOperatorDoctorTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
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
      const identity = authIdentity(extra.authInfo);
      if (identity?.role !== "admin" && identity?.role !== "ob-admin") {
        return errorResult("Permission denied: admin or ob-admin role required");
      }

      try {
        const status = await getOperatorDoctorStatus(
          dependencies.pool,
          readNatsRuntimeBoundary(process.env),
        );
        dependencies.logger.info(
          { tool: "operator_doctor", status: status.status },
          "tool_result",
        );
        return textResult(status);
      } catch (error) {
        dependencies.logger.error(
          {
            tool: "operator_doctor",
            error: error instanceof Error ? error.message : String(error),
          },
          "doctor_tool_failed",
        );
        return errorResult("operator doctor status unavailable");
      }
    },
  );
}
