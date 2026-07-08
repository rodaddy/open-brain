import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
  getParseErrorMessage,
  normalizeObjectSchema,
  safeParseAsync,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { captureRawArgsForAudit } from "./audit-log.ts";

export interface ValidationFieldIssue {
  field: string;
  code: string;
  message: string;
  constraint?: string;
  expected?: unknown;
  received?: unknown;
  options?: unknown[];
}

export interface ValidationSummary {
  error: "input_validation_failed";
  tool: string;
  fields: ValidationFieldIssue[];
}

interface ToolWithInputSchema {
  inputSchema?: AnySchema | ZodRawShapeCompat;
}

interface ZodIssueLike {
  path?: Array<string | number>;
  code?: string;
  message?: string;
  expected?: unknown;
  received?: unknown;
  options?: unknown[];
  values?: unknown[];
  minimum?: unknown;
  maximum?: unknown;
}

function fieldPath(path: ZodIssueLike["path"]): string {
  if (!path || path.length === 0) return "$";
  return path.map(String).join(".");
}

function constraintFor(issue: ZodIssueLike): string | undefined {
  if (issue.code === "invalid_value" && issue.values) {
    return `must be one of ${issue.values.map(String).join(", ")}`;
  }
  if (issue.code === "invalid_enum_value" && issue.options) {
    return `must be one of ${issue.options.map(String).join(", ")}`;
  }
  if (issue.minimum !== undefined) return `minimum ${String(issue.minimum)}`;
  if (issue.maximum !== undefined) return `maximum ${String(issue.maximum)}`;
  return issue.message;
}

export function summarizeValidationError(
  toolName: string,
  error: unknown,
): ValidationSummary {
  const issues =
    typeof error === "object" && error !== null && "issues" in error
      ? ((error as { issues?: unknown }).issues as unknown)
      : undefined;

  const fields = Array.isArray(issues)
    ? issues.slice(0, 20).map((raw): ValidationFieldIssue => {
        const issue = raw as ZodIssueLike;
        return {
          field: fieldPath(issue.path),
          code: issue.code ?? "invalid",
          message: issue.message ?? "Invalid value",
          constraint: constraintFor(issue),
          expected: issue.expected,
          received: issue.received,
          options: issue.options ?? issue.values,
        };
      })
    : [
        {
          field: "$",
          code: "invalid",
          message: getParseErrorMessage(error),
        },
      ];

  return {
    error: "input_validation_failed",
    tool: toolName,
    fields,
  };
}

export function formatValidationSummary(summary: ValidationSummary): string {
  const json = JSON.stringify(summary);
  return `Input validation error: ${json}`;
}

export async function validateToolInputWithSummary(
  tool: ToolWithInputSchema,
  args: unknown,
  toolName: string,
): Promise<unknown> {
  if (!tool.inputSchema) return undefined;

  const inputObj = normalizeObjectSchema(tool.inputSchema);
  const schemaToParse = inputObj ?? tool.inputSchema;
  const parseResult = await safeParseAsync(schemaToParse as AnySchema, args);
  if (!parseResult.success) {
    const error = "error" in parseResult ? parseResult.error : "Unknown error";
    const summary = summarizeValidationError(toolName, error);
    throw new McpError(
      ErrorCode.InvalidParams,
      formatValidationSummary(summary),
    );
  }
  // This hook is the only repo-owned layer that still sees the RAW
  // request.params.arguments (Zod strips undeclared keys from parsed data).
  // Capture raw-args audit facts keyed by the parsed-data object, which the
  // SDK hands unchanged to the tool handler where the audit wrapper runs.
  captureRawArgsForAudit(args, parseResult.data);
  return parseResult.data;
}
