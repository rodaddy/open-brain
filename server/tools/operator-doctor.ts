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
 * natsBridgeHealth)`. The boundary is INJECTED, from
 * `natsRuntimeBoundaryFromConfig(config.nats)` at the composition root: the
 * same parsed `NatsConfig` the bridge and `/health` already answer from. It
 * used to be read here from the ambient environment, which made the doctor a
 * second opinion on the transport -- it could report `nats` while the process
 * was serving http, because nothing tied the two reads together. `server/config/`
 * owns env parsing (`_plans/463-server-rewrite-charter.md:108,119`), so the
 * doctor now reports the boundary in force rather than re-deriving one.
 *
 * The fallback when nothing is injected is the boundary an EMPTY environment
 * produces, not a re-read: a caller that registers tools without a composition
 * root has no transport configured, and that is exactly what the empty-env
 * boundary declares.
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
import { readNatsRuntimeBoundary } from "../application/nats-runtime.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";

/**
 * The boundary an unconfigured deployment declares.
 *
 * Derived ONCE from the reader itself against an empty environment, rather than
 * hand-written, so it cannot drift from the shape `readNatsRuntimeBoundary`
 * produces if that shape gains a field. The input is the EMPTY object:
 * no environment is consulted, and the answer is the constant "http transport,
 * no bridge requested" that an unwired caller is entitled to.
 */
const UNCONFIGURED_NATS_BOUNDARY = readNatsRuntimeBoundary({});

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
          dependencies.natsRuntimeBoundary ?? UNCONFIGURED_NATS_BOUNDARY,
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
