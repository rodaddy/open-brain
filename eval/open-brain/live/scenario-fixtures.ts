import { z } from "zod";
import type { ScenarioFixture } from "./scenario-types.ts";

const scopeSchema = z.object({
  agent: z.string().min(1),
  platform: z.string().min(1),
  server_id: z.string().min(1),
  channel_id: z.string().min(1),
  thread_id: z.string().min(1).nullable().optional(),
  session_key: z.string().min(1),
  project: z.string().min(1),
});

const captureRequestSchema = z.object({
  operation: z.literal("capture"),
  distilled: z.literal(true),
  content: z.string().min(1),
  event_type: z.string().min(1),
  scope: scopeSchema,
  optional_request_fields: z.record(z.string(), z.unknown()).optional(),
});

const checkpointRequestSchema = z.object({
  operation: z.literal("checkpoint"),
  distilled: z.literal(true),
  summary: z.string().min(1),
  key_decisions: z.array(z.string()),
  next_steps: z.array(z.string()),
  scope: scopeSchema,
});

const scenarioSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("capture_round_trip"),
    request: captureRequestSchema,
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("durable_memory_shape"),
    seed: z.object({
      table: z.enum(["thoughts", "decisions"]),
      content: z.string().min(1),
      tags: z.array(z.string()),
    }),
    request: z.object({
      query: z.string().min(1),
      budget_max_tokens: z.number().int().min(100),
      scope: scopeSchema,
    }),
    expected: z.object({
      section: z.literal("durable_memory"),
      min_items: z.number().int().min(1),
    }),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("checkpoint_round_trip"),
    event: captureRequestSchema,
    checkpoint: checkpointRequestSchema,
  }),
]);

export const scenarioFixtureSchema: z.ZodType<ScenarioFixture> = z.object({
  schema_version: z.literal(1),
  fixture_id: z.string().min(1),
  description: z.string(),
  scenarios: z.array(scenarioSchema).min(1),
});

export function parseScenarioFixture(raw: unknown): ScenarioFixture {
  const fixture = scenarioFixtureSchema.parse(raw);
  const ids = new Set<string>();
  for (const scenario of fixture.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return fixture;
}

export async function loadScenarioFixture(path: string): Promise<ScenarioFixture> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read scenario fixture ${path}: ${message}`);
  }
  try {
    return parseScenarioFixture(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid scenario fixture ${path}: ${message}`);
  }
}
