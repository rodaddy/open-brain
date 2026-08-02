import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import type { Pool } from "pg";
import type { AuthIdentity } from "../auth/types.ts";

export interface MemoryToolDependencies {
  readonly pool: Pool;
  readonly embedFn: (text: string) => Promise<number[] | null>;
  readonly logger: Logger;
  readonly embeddingModel?: string;
  /**
   * Resolved qmd entry point for `search_all`'s file-index arm.
   *
   * Injected so a test can federate against a stub without spawning anything,
   * and so the resolution rule lives at the composition root rather than being
   * re-derived inside a handler. Absent means qmd federation is off, and
   * `search_all` says so in its log rather than quietly returning brain-only
   * results (`docs/qmd-ob-layered-recall.md` records the silent-degradation
   * defect this avoids).
   */
  readonly qmdPath?: string;
}

export interface McpAuthInfo {
  readonly role: AuthIdentity["role"];
  readonly clientId: string;
  readonly tokenClientId?: string;
  readonly agentId?: string;
  readonly namespaceSource?: "token" | "header" | "delegated";
}

export type MemoryToolRegistrar = (
  server: McpServer,
  dependencies: MemoryToolDependencies,
) => void;

export function authIdentity(value: unknown): AuthIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const auth = value as Partial<McpAuthInfo>;
  if (!auth.role || !auth.clientId) return undefined;
  return {
    role: auth.role,
    clientId: auth.clientId,
    tokenClientId: auth.tokenClientId ?? auth.clientId,
    namespaceSource:
      auth.namespaceSource === "header" || auth.namespaceSource === "delegated"
        ? "delegated"
        : "token",
  };
}

export function textResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

export function errorResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { ...textResult(text), isError: true };
}
