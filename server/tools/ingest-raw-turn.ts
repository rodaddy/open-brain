import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { authorize, contentHash } from "./memory-helpers.ts";
import { RAW_TURN_ROLES } from "../domain/raw-turn-roles.ts";

const harnessNoise = [
  /^\[Request interrupted by user[^\]]*\]$/,
  /^<local-command-(?:caveat|stdout|stderr)>/,
  /^<command-(?:name|message|args)>/,
  /^<bash-(?:input|stdout|stderr)>/,
  /^Continue from where you left off\.$/,
  /^The user doesn't want to proceed with this tool use\./,
];

const rawTurnSchema = z.object({
  turn_uuid: z.string().min(1).max(200),
  parent_turn_uuid: z.string().min(1).max(200).nullish(),
  logical_parent_turn_uuid: z.string().min(1).max(200).nullish(),
  prompt_id: z.string().min(1).max(200).nullish(),
  session_ref: z.string().min(1).max(500).nullish(),
  repo: z.string().min(1).max(200).nullish(),
  git_branch: z.string().min(1).max(300).nullish(),
  turn_index: z.number().int().min(0),
  // The accepted set is declared once (#681). The liveness observer seeds its
  // expected roles from this same export, so a role added here cannot be a role
  // the health check stays blind to.
  role: z.enum(RAW_TURN_ROLES),
  is_human_prompt: z.boolean().optional(),
  content: z.string(),
  runtime: z.string().min(1).max(100).nullish(),
  token_estimate: z.number().int().min(0).nullish(),
  occurred_at: z.string().datetime({ offset: true }).nullish(),
  metadata: z.record(z.string().max(100), z.unknown()).optional(),
});

type RawTurn = z.infer<typeof rawTurnSchema>;

function isHarnessNoise(content: string): boolean {
  return (
    /^\s*$/.test(content) ||
    harnessNoise.some((pattern) => pattern.test(content))
  );
}

export function registerIngestRawTurnTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "ingest_raw_turn",
    {
      description:
        "Full-send ingest of raw conversation turns for server-side distillation",
      inputSchema: {
        namespace: z.string().max(500).optional(),
        turns: z.array(rawTurnSchema).min(1).max(100),
      },
      annotations: {
        title: "Ingest Raw Turn",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = authorize(authIdentity(extra.authInfo), {
        operation: "write",
        table: "sessions",
        permissionMessage: "cannot write raw turns",
        requestedNamespace: args.namespace,
      });
      if (!auth.ok) return auth.response;
      const kept = args.turns.filter((turn) => !isHarnessNoise(turn.content));
      const filtered = args.turns.length - kept.length;
      if (kept.length === 0) {
        return textResult({
          ingested: 0,
          duplicates: 0,
          filtered,
          namespace: auth.namespace,
        });
      }
      try {
        const values: unknown[] = [];
        const tuples = kept.map((turn, index) => {
          appendTurnValues(
            values,
            auth.namespace,
            auth.identity.clientId,
            turn,
          );
          const first = index * 19 + 1;
          return `(${Array.from({ length: 19 }, (_, offset) => `$${first + offset}`).join(",")})`;
        });
        const rows = await dependencies.pool.query(
          `INSERT INTO ob_raw_turns
             (namespace, turn_uuid, parent_turn_uuid, logical_parent_turn_uuid,
              prompt_id, session_ref, repo, git_branch, turn_index, role,
              is_human_prompt, content, content_hash, runtime, token_estimate,
              metadata, redaction_applied, created_by, occurred_at)
           VALUES ${tuples.join(",")}
           ON CONFLICT (namespace, turn_uuid) DO NOTHING
           RETURNING id`,
          values,
        );
        const ingested = rows.rows.length;
        dependencies.logger.info(
          {
            tool: "ingest_raw_turn",
            ingested,
            duplicates: kept.length - ingested,
            filtered,
          },
          "tool_result",
        );
        return textResult({
          ingested,
          duplicates: kept.length - ingested,
          filtered,
          namespace: auth.namespace,
        });
      } catch (error: unknown) {
        dependencies.logger.error(
          {
            tool: "ingest_raw_turn",
            error_category: error instanceof Error ? error.name : typeof error,
          },
          "tool_failure",
        );
        return errorResult(
          JSON.stringify({
            error: "retryable_outage",
            message: `Database error during raw turn ingest: ${error instanceof Error ? error.message : String(error)}`,
            retryable: true,
            namespace: auth.namespace,
          }),
        );
      }
    },
  );
}

// Columns 1-10: namespace and the lineage/routing identifiers that place a turn
// in its conversation. Order matches the INSERT column list exactly.
function turnLineageValues(namespace: string, turn: RawTurn): unknown[] {
  return [
    namespace,
    turn.turn_uuid,
    turn.parent_turn_uuid ?? null,
    turn.logical_parent_turn_uuid ?? null,
    turn.prompt_id ?? null,
    turn.session_ref ?? null,
    turn.repo ?? null,
    turn.git_branch ?? null,
    turn.turn_index,
    turn.role,
  ];
}

// Columns 11-19: the turn's own payload plus the ingest-side stamps. Order
// matches the INSERT column list exactly.
function turnPayloadValues(createdBy: string, turn: RawTurn): unknown[] {
  return [
    turn.is_human_prompt ?? false,
    turn.content,
    contentHash(turn.content),
    turn.runtime ?? null,
    turn.token_estimate ?? null,
    JSON.stringify(turn.metadata ?? {}),
    JSON.stringify([]),
    createdBy,
    turn.occurred_at ?? null,
  ];
}

function appendTurnValues(
  values: unknown[],
  namespace: string,
  createdBy: string,
  turn: RawTurn,
): void {
  values.push(
    ...turnLineageValues(namespace, turn),
    ...turnPayloadValues(createdBy, turn),
  );
}
