/**
 * Skill and canon usage telemetry: record an invocation, report the counts.
 *
 * Design authority: issue #469, whose operator ruling is the whole shape of
 * this module -- "no automatic retirement. What I need is something that gives
 * me metrics so that decisions can be made on facts and not on feel." Both
 * tools here are METRICS ONLY. `record_skill_usage` appends one row per
 * invocation; `skill_usage_report` counts rows. Neither categorises,
 * recommends, rotates, shelves, nor retires anything, and neither is allowed to
 * grow a field that does -- the issue body forbids all five by name. Rico reads
 * the counts and makes those calls himself.
 *
 * WHAT IS RECORDED, AND WHAT IS DELIBERATELY NOT.
 *
 * Four dimensions and a timestamp: which skill, which agent, which repo, which
 * session, when. NOT the tool input, NOT the tool response, NOT the prompt.
 * That content stream is the explicitly OPEN question in
 * `docs/decisions/capture-never-drops-a-turn.md` (memory versus observability),
 * and the `PostToolUse` stub's docstring warns in terms against resolving it by
 * accident. Counting invocations needs none of it, so this takes none of it.
 *
 * NAMESPACE SCOPING IS BY JOIN, NOT BY COLUMN.
 *
 * `skill_usage_log` carries no `namespace` column (046_skill_usage_log.sql),
 * exactly like `entry_access_log`. The scoping rule is the one `reporting.ts`
 * already establishes for that table: the log has no namespace of its own, so
 * every read joins back to the owning `ob_entities` row and applies the
 * auth-derived predicate THERE. Reading the log without that join would report
 * another namespace's usage pattern to any caller -- which skills another
 * tenant runs, and how often, is exactly the kind of profile this must not
 * leak. `skillUsageReadScope()` below is the single place that join is built,
 * and `skill-usage.pg.test.ts` proves the predicate holds by asserting a second
 * namespace's rows stay invisible.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead, canWrite } from "../auth/permissions.ts";
import {
  canTargetNamespace,
  namespacePredicate,
} from "../auth/namespace-policy.ts";
import type { AuthIdentity } from "../auth/types.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { qualifyNamespacePredicate } from "./curation-helpers.ts";

/**
 * The `ob_entities.entity_type` skills and canon rules are seeded under.
 *
 * One type, not two, because the usage KIND is a column on the log row
 * (`usage_kind`) rather than a second entity type: a canon rule and a skill are
 * both "a named thing an agent loaded", and keeping one entity type means the
 * seed upsert and the report join have one shape instead of two.
 */
export const SKILL_ENTITY_TYPE = "skill";

/** How many rows the report returns before the caller narrows its window. */
const REPORT_LIMIT = 200;

/** Default reporting window, in days. */
const DEFAULT_REPORT_DAYS = 7;

export function registerSkillUsageTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerRecordSkillUsage(server, dependencies);
  registerSkillUsageReport(server, dependencies);
}
/** Frozen `record_skill_usage` argument contract: the names and rule values are the API. */
const recordSkillUsageInputSchema = {
  skill_slug: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Slug of the skill or canon rule that was invoked"),
  usage_kind: z
    .enum(["skill", "canon"])
    .optional()
    .describe("Whether a skill or a canon rule was loaded"),
  agent: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Agent that invoked it"),
  repo: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Repository the invocation happened in"),
  session_id: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Harness session the invocation belongs to"),
  runtime: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Emitting runtime, e.g. claude-code, codex, pi"),
  namespace: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Namespace the skill entity belongs to"),
};

/** Frozen `skill_usage_report` argument contract. */
const skillUsageReportInputSchema = {
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(`Window in days (default ${DEFAULT_REPORT_DAYS})`),
  usage_kind: z
    .enum(["skill", "canon"])
    .optional()
    .describe("Restrict the report to one kind"),
};

type RecordSkillUsageArgs = {
  skill_slug: string;
  usage_kind?: "skill" | "canon" | undefined;
  agent?: string | undefined;
  repo?: string | undefined;
  session_id?: string | undefined;
  runtime?: string | undefined;
  namespace?: string | undefined;
};

type SkillUsageReportArgs = {
  days?: number | undefined;
  usage_kind?: "skill" | "canon" | undefined;
};

/**
 * Build the namespace-scoped join from the usage log to its owning entity.
 *
 * The log row is only visible when the `ob_entities` row it points at is
 * readable by this identity. Returns the SQL fragment and the parameter values
 * it consumes, appended to `values` in place so the caller keeps one parameter
 * sequence.
 *
 * @param identity - The auth-derived identity whose read scope applies.
 * @param values - The running parameter list, extended with the predicate's.
 * @returns A `JOIN ... ON ...` fragment binding `sul` to entity alias `e`.
 */
function skillUsageReadScope(
  identity: AuthIdentity,
  values: unknown[],
): string {
  const predicate = namespacePredicate(identity, "read", values.length + 1);
  values.push(...predicate.values);
  const scoped = qualifyNamespacePredicate(
    predicate,
    "e.namespace",
    values.length,
  );
  return ` JOIN ob_entities e
             ON e.id = sul.entity_id
            AND e.archived_at IS NULL${scoped}`;
}

/**
 * Seed (or touch) the `ob_entities` row the usage log row points at.
 *
 * The entity is seeded on first use rather than requiring a separate seeding
 * pass: telemetry that silently dropped an invocation because nobody had
 * registered the skill yet would under-count exactly the new skills whose
 * adoption Rico most wants to see. `skill.<slug>` matches the scope-key pattern
 * canon seeding already uses, and the upsert is the `ob_entities` shape from
 * `repo-facts.ts`.
 */
async function seedSkillEntity(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  request: { skillSlug: string; usageKind: string; namespace: string },
): Promise<string | undefined> {
  const entityName = `${SKILL_ENTITY_TYPE}.${request.skillSlug}`;
  const { rows } = await dependencies.pool.query(
    `INSERT INTO ob_entities
       (entity_type, name, namespace, metadata, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (namespace, entity_type, lower(name))
     WHERE archived_at IS NULL
     DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [
      SKILL_ENTITY_TYPE,
      entityName,
      request.namespace,
      JSON.stringify({
        skill_slug: request.skillSlug,
        usage_kind: request.usageKind,
      }),
      identity.clientId,
    ],
  );
  return rows[0]?.id as string | undefined;
}

/** Append the one usage row and return it as stored. */
async function appendUsageRow(
  dependencies: MemoryToolDependencies,
  entityId: string,
  args: RecordSkillUsageArgs,
  usageKind: string,
): Promise<unknown> {
  const { rows } = await dependencies.pool.query(
    `INSERT INTO skill_usage_log
       (entity_id, skill_slug, agent, repo, session_id, runtime, usage_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, entity_id, skill_slug, agent, repo, session_id, runtime,
               usage_kind, invoked_at`,
    [
      entityId,
      args.skill_slug,
      args.agent ?? null,
      args.repo ?? null,
      args.session_id ?? null,
      args.runtime ?? null,
      usageKind,
    ],
  );
  return rows[0];
}

/** Counts per skill x agent x repo x runtime -- the four dimensions #469 names. */
async function queryUsageCounts(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  args: SkillUsageReportArgs,
  days: number,
): Promise<Record<string, unknown>[]> {
  const values: unknown[] = [];
  const join = skillUsageReadScope(identity, values);
  values.push(days);
  const windowParameter = `$${values.length}`;
  const kindFilter = args.usage_kind
    ? ` AND sul.usage_kind = $${values.push(args.usage_kind)}`
    : "";
  const { rows } = await dependencies.pool.query(
    `SELECT sul.skill_slug,
            sul.usage_kind,
            sul.agent,
            sul.repo,
            sul.runtime,
            COUNT(*)::int          AS invocations,
            MAX(sul.invoked_at)    AS last_used_at
       FROM skill_usage_log sul${join}
      WHERE sul.invoked_at >= NOW() - (${windowParameter} || ' days')::interval${kindFilter}
      GROUP BY sul.skill_slug, sul.usage_kind, sul.agent, sul.repo,
               sul.runtime
      ORDER BY invocations DESC, sul.skill_slug ASC
      LIMIT ${REPORT_LIMIT}`,
    values,
  );
  return rows;
}

/**
 * The prior window of equal length, so the caller can see the trend as two
 * counts rather than as a word this tool is not allowed to supply.
 */
async function queryPriorWindow(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  args: SkillUsageReportArgs,
  days: number,
): Promise<Record<string, number>> {
  const trendValues: unknown[] = [];
  const trendJoin = skillUsageReadScope(identity, trendValues);
  trendValues.push(days);
  const trendWindow = `$${trendValues.length}`;
  const trendKindFilter = args.usage_kind
    ? ` AND sul.usage_kind = $${trendValues.push(args.usage_kind)}`
    : "";
  const { rows } = await dependencies.pool.query(
    `SELECT sul.skill_slug, COUNT(*)::int AS invocations
       FROM skill_usage_log sul${trendJoin}
      WHERE sul.invoked_at <  NOW() - (${trendWindow} || ' days')::interval
        AND sul.invoked_at >= NOW() - (${trendWindow} || ' days')::interval * 2${trendKindFilter}
      GROUP BY sul.skill_slug`,
    trendValues,
  );
  const priorWindow: Record<string, number> = {};
  for (const row of rows) {
    priorWindow[String(row.skill_slug)] = Number(row.invocations);
  }
  return priorWindow;
}

/**
 * Seeded skills with no invocation inside the window. #469 asks for this list
 * explicitly, and it is a LIST of names with zero counts -- naming what went
 * unused is a fact; deciding what to do about it is Rico's.
 */
async function queryNeverUsed(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  days: number,
): Promise<string[]> {
  const neverValues: unknown[] = [];
  const neverPredicate = namespacePredicate(
    identity,
    "read",
    neverValues.length + 1,
  );
  neverValues.push(...neverPredicate.values);
  const neverScoped = qualifyNamespacePredicate(
    neverPredicate,
    "e.namespace",
    neverValues.length,
  );
  neverValues.push(days);
  const neverWindow = `$${neverValues.length}`;
  const { rows } = await dependencies.pool.query(
    `SELECT e.name
       FROM ob_entities e
      WHERE e.entity_type = '${SKILL_ENTITY_TYPE}'
        AND e.archived_at IS NULL${neverScoped}
        AND NOT EXISTS (
              SELECT 1
                FROM skill_usage_log sul
               WHERE sul.entity_id = e.id
                 AND sul.invoked_at >=
                     NOW() - (${neverWindow} || ' days')::interval
            )
      ORDER BY e.name ASC
      LIMIT ${REPORT_LIMIT}`,
    neverValues,
  );
  return rows.map((row) => String(row.name));
}

/** Shape one usage row for the response, carrying its prior-window count. */
function usageEntry(
  row: Record<string, unknown>,
  priorWindow: Record<string, number>,
): Record<string, unknown> {
  return {
    skill_slug: String(row.skill_slug),
    usage_kind: String(row.usage_kind),
    agent: row.agent === null ? null : String(row.agent),
    repo: row.repo === null ? null : String(row.repo),
    runtime: row.runtime === null ? null : String(row.runtime),
    invocations: Number(row.invocations),
    last_used_at: row.last_used_at,
    prior_window_invocations: priorWindow[String(row.skill_slug)] ?? 0,
  };
}

/** Record one invocation end to end, once the identity has been authorized. */
async function recordSkillUsage(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  args: RecordSkillUsageArgs,
): Promise<{ error: string } | { recorded: true; usage: unknown }> {
  const namespace = args.namespace ?? identity.clientId;
  if (!canTargetNamespace(identity, "write", namespace)) {
    return { error: "Permission denied: namespace write denied" };
  }
  const usageKind = args.usage_kind ?? "skill";
  const entityId = await seedSkillEntity(dependencies, identity, {
    skillSlug: args.skill_slug,
    usageKind,
    namespace,
  });
  if (!entityId) {
    return { error: "Failed to resolve skill entity" };
  }
  const usage = await appendUsageRow(dependencies, entityId, args, usageKind);
  return { recorded: true, usage };
}

/** Build the whole report, once the identity has been authorized. */
async function buildSkillUsageReport(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  args: SkillUsageReportArgs,
): Promise<Record<string, unknown>> {
  const days = args.days ?? DEFAULT_REPORT_DAYS;
  const usage = await queryUsageCounts(dependencies, identity, args, days);
  const priorWindow = await queryPriorWindow(
    dependencies,
    identity,
    args,
    days,
  );
  const neverUsed = await queryNeverUsed(dependencies, identity, days);
  return {
    window_days: days,
    usage: usage.map((row) => usageEntry(row, priorWindow)),
    never_used: neverUsed,
  };
}

function registerRecordSkillUsage(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "record_skill_usage",
    {
      description:
        "Records one skill or canon invocation as a usage metric: which skill, which agent, which repo, which session, and when. Metrics only -- it never categorizes, recommends, rotates, shelves, or retires anything.",
      inputSchema: recordSkillUsageInputSchema,
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canWrite(identity.role, "sessions")) {
        return errorResult("Permission denied: write access required");
      }
      const outcome = await recordSkillUsage(dependencies, identity, args);
      if ("error" in outcome) return errorResult(outcome.error);
      return textResult(outcome);
    },
  );
}

function registerSkillUsageReport(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "skill_usage_report",
    {
      description:
        "Reports skill and canon invocation counts per skill, agent, repo, and runtime over a window, with last-used timestamps and an explicit never-used list. Facts only -- no categorization, recommendation, rotation, shelving, or retirement.",
      inputSchema: skillUsageReportInputSchema,
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canRead(identity.role, "sessions")) {
        return errorResult("Permission denied: read access required");
      }
      return textResult(
        await buildSkillUsageReport(dependencies, identity, args),
      );
    },
  );
}
