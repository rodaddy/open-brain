/**
 * Skill and canon usage telemetry: record an invocation, report the counts.
 *
 * Both tools are METRICS ONLY (issue #469), the content stream is deliberately
 * not captured, and namespace scoping is a join through `ob_entities` rather
 * than a column on `skill_usage_log` -- `skillUsageReadScope()` below is the
 * single place that join is built.
 *
 * See docs/decisions/skill-usage-is-metrics-only.md
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead, canWrite } from "../auth/permissions.ts";
import { canTargetNamespace, namespacePredicate } from "../auth/namespace-policy.ts";
import type { AuthIdentity } from "../auth/types.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { qualifyNamespacePredicate } from "./curation-helpers.ts";
import { createEntityReportRepository } from "../db/entity-report-repository.ts";

/**
 * The `ob_entities.entity_type` skills and canon rules are seeded under.
 *
 * One type, not two, because the usage KIND is a column on the log row
 * (`usage_kind`) rather than a second entity type: a canon rule and a skill are
 * both "a named thing an agent loaded", and keeping one entity type means the
 * seed upsert and the report join have one shape instead of two.
 */
const SKILL_ENTITY_TYPE = "skill";

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
  agent: z.string().trim().min(1).max(200).optional().describe("Agent that invoked it"),
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
function skillUsageReadScope(identity: AuthIdentity, values: unknown[]): string {
  const predicate = namespacePredicate(identity, "read", values.length + 1);
  values.push(...predicate.values);
  const scoped = qualifyNamespacePredicate(predicate, "e.namespace", values.length);
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
  const repository = createEntityReportRepository(dependencies.pool);
  const rows = await repository.seedSkillEntity({
    entityType: SKILL_ENTITY_TYPE,
    entityName,
    namespace: request.namespace,
    metadata: JSON.stringify({
      skill_slug: request.skillSlug,
      usage_kind: request.usageKind,
    }),
    createdBy: identity.clientId,
  });
  return rows[0]?.id as string | undefined;
}

/** Append the one usage row and return it as stored. */
async function appendUsageRow(
  dependencies: MemoryToolDependencies,
  entityId: string,
  args: RecordSkillUsageArgs,
  usageKind: string,
): Promise<unknown> {
  const repository = createEntityReportRepository(dependencies.pool);
  const rows = await repository.appendUsageRow({
    entityId,
    skillSlug: args.skill_slug,
    agent: args.agent ?? null,
    repo: args.repo ?? null,
    sessionId: args.session_id ?? null,
    runtime: args.runtime ?? null,
    usageKind,
  });
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
  const repository = createEntityReportRepository(dependencies.pool);
  const rows = await repository.usageCounts({
    join,
    windowParameter,
    kindFilter,
    reportRowCount: REPORT_LIMIT,
    parameters: values,
  });
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
  const repository = createEntityReportRepository(dependencies.pool);
  const rows = await repository.priorWindowCounts({
    join: trendJoin,
    windowParameter: trendWindow,
    kindFilter: trendKindFilter,
    parameters: trendValues,
  });
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
  const neverPredicate = namespacePredicate(identity, "read", neverValues.length + 1);
  neverValues.push(...neverPredicate.values);
  const neverScoped = qualifyNamespacePredicate(
    neverPredicate,
    "e.namespace",
    neverValues.length,
  );
  neverValues.push(days);
  const neverWindow = `$${neverValues.length}`;
  const repository = createEntityReportRepository(dependencies.pool);
  const rows = await repository.neverUsedSkills({
    entityType: SKILL_ENTITY_TYPE,
    scoped: neverScoped,
    windowParameter: neverWindow,
    reportRowCount: REPORT_LIMIT,
    parameters: neverValues,
  });
  return rows.map((row) => String(row.name));
}

/** Narrow one nullable text column to a string, leaving SQL NULL as null. */
function optionalText(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Shape one usage row for the response, carrying its prior-window count. */
function usageEntry(
  row: Record<string, unknown>,
  priorWindow: Record<string, number>,
): Record<string, unknown> {
  const agent = optionalText(row.agent);
  const repo = optionalText(row.repo);
  const runtime = optionalText(row.runtime);
  return {
    skill_slug: String(row.skill_slug),
    usage_kind: String(row.usage_kind),
    agent,
    repo,
    runtime,
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
  const priorWindow = await queryPriorWindow(dependencies, identity, args, days);
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
      return textResult(await buildSkillUsageReport(dependencies, identity, args));
    },
  );
}
