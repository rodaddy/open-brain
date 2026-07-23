import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import {
  collectDropFolder,
  type CollectDropFolderResult,
} from "../drop-folder-collector.ts";
import type { ToolDeps } from "./index.ts";

// Content-free label for a thrown error: an allowlisted class/name or code only
// -- never err.message, which can carry a raw driver string echoing a drop body
// or path. Mirrors extraction.ts / source-registry.ts so collector logs stay
// body-free.
function internalErrorLabel(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Za-z_]{1,32}$/.test(code)) {
      return code;
    }
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z_]{1,64}$/.test(name)) {
      return name;
    }
  }
  return "unknown_error";
}

// One stable, content-free envelope for an UNEXPECTED failure that escapes the
// collector. Fixed text; never carries err.message, an external_id, a body, or a
// path.
function internalError() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          code: "internal_error",
          error: "drop folder collection failed",
        }),
      },
    ],
    isError: true,
  };
}

function okResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}

function unauthenticated() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          code: "unauthenticated",
          error: "not authenticated",
        }),
      },
    ],
    isError: true,
  };
}

// The content-free public view of a collection result. The collector result is
// already body-free (typed codes, opaque digests, counts, durable ids); this
// centralizes the tool shape so no internal-only field can leak later.
function publicResult(result: CollectDropFolderResult) {
  if (!result.eligible) {
    return {
      ok: false,
      eligible: false as const,
      code: result.code,
    };
  }
  return {
    ok: true,
    eligible: true as const,
    namespace: result.namespace,
    collected: result.collected,
    deduped: result.deduped,
    rejected: result.rejected,
    items: result.items,
  };
}

const tagsArg = z
  .array(z.string().trim().min(1).max(120))
  .max(64)
  .describe("Content-free tags to carry onto the durable row (never bodies)");

export function registerDropFolderCollector(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "collect_drop_folder",
    {
      description:
        "Collect caller-supplied drop items for a registered, approved, active " +
        "'drop' source. Only an approved+active drop source in a readable " +
        "namespace is eligible; unregistered or unapproved sources are rejected " +
        "truthfully. Repeated identical content dedupes by hash and is a no-op.",
      inputSchema: {
        external_id: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .describe("The registered drop source's stable external locator"),
        target_namespace: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Namespace the drop source lives in. Defaults to your own. A " +
              "global admin/ob-admin token may target another namespace; " +
              "header-scoped identities are bound to their header namespace.",
          ),
        items: z
          .array(
            z
              .object({
                external_id: z.string().trim().min(1).max(1000),
                content: z.string().min(1),
                tags: tagsArg.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(256)
          .describe("Bounded batch of drop items belonging to this source"),
      },
      annotations: {
        title: "Collect Drop Folder",
        readOnlyHint: false,
        destructiveHint: false,
        // Repeated identical content is a no-op (dedupe by hash), so a re-run of
        // the same batch produces no new durable state.
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) return unauthenticated();
      try {
        const result = await collectDropFolder(deps, auth, args);
        logger.info("collect_drop_folder_result", {
          eligible: result.eligible,
          code: result.code,
          collected: result.collected,
          deduped: result.deduped,
          rejected: result.rejected,
        });
        return okResult(publicResult(result));
      } catch (err) {
        logger.error("collect_drop_folder_internal_error", {
          error: internalErrorLabel(err),
        });
        return internalError();
      }
    },
  );
}
