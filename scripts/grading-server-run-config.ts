import { parseGradedBy } from "../server/domain/candidate-review/index.ts";
import { DEFAULT_GRADING_PORT } from "../server/application/grading-server.ts";
import { assertDreamRunSchema } from "./rem-ethereal-cohort.ts";
import { arg, has } from "./run-support/argv.ts";

export interface GradingServerRunConfig {
  namespace: string;
  gradedBy: string;
  port: number;
  frozenSchema?: string;
}

export async function startWithPoolCleanup<T>(
  start: () => Promise<T>,
  closePool: () => Promise<void>,
): Promise<T> {
  try {
    return await start();
  } catch (error: unknown) {
    await closePool();
    throw error;
  }
}

function requiredFlagValue(name: string): string {
  const value = arg(name);
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${name} requires a non-empty value`);
  return trimmed;
}

function parsePort(env: NodeJS.ProcessEnv): number {
  const port = Number(arg("--port") ?? env.GRADING_PORT ?? DEFAULT_GRADING_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("grading port must be an integer from 1 through 65535");
  }
  return port;
}

function normalConfig(env: NodeJS.ProcessEnv, port: number): GradingServerRunConfig {
  return {
    namespace: arg("--namespace") ?? env.OB_GRADING_NAMESPACE ?? "rico",
    gradedBy: arg("--graded-by") ?? env.GRADED_BY ?? "rico",
    port,
  };
}

function frozenConfig(env: NodeJS.ProcessEnv, port: number): GradingServerRunConfig {
  const frozenSchema = requiredFlagValue("--frozen-schema");
  assertDreamRunSchema(frozenSchema);
  if (!has("--namespace")) {
    throw new Error("--namespace is required with --frozen-schema");
  }
  const namespace = requiredFlagValue("--namespace");
  const rawGradedBy = has("--graded-by")
    ? requiredFlagValue("--graded-by")
    : env.GRADED_BY;
  if (rawGradedBy === undefined) {
    throw new Error("--graded-by or GRADED_BY is required with --frozen-schema");
  }
  const gradedBy = parseGradedBy(rawGradedBy);
  return { namespace, gradedBy, port, frozenSchema };
}

export function parseGradingServerRunConfig(
  env: NodeJS.ProcessEnv = process.env,
): GradingServerRunConfig {
  const port = parsePort(env);
  if (!has("--frozen-schema")) {
    return normalConfig(env, port);
  }
  return frozenConfig(env, port);
}
