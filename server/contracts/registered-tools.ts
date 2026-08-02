import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryTools } from "../tools/index.ts";
import type { MemoryToolDependencies } from "../tools/types.ts";

/**
 * The tool names the rewrite ACTUALLY registers, observed by running the real
 * registrar.
 *
 * This drives `registerMemoryTools()` -- the same function `server/index.ts`
 * calls -- against a recording stand-in for `McpServer`, rather than scanning
 * `server/tools/*.ts` for a `registerTool(` string. Source scanning is what the
 * src-side gap map does, and it is load-bearing there because it also has to
 * attribute a tool to a file; here it would be a second, weaker model of the
 * registry that a regex detail can silently falsify. That is not hypothetical:
 * `src/tools` puts the tool name on the same line as `registerTool(` while
 * `server/tools` puts it on the next line, so the existing single-line pattern
 * finds ZERO rewrite tools. A check that reports "nothing missing" because its
 * regex matched nothing is the exact failure this whole change exists to remove.
 *
 * Registration is pure name/schema/handler bookkeeping -- no handler runs and
 * nothing touches the pool -- so the dependencies are never dereferenced.
 */
function collectRegisteredTools(): string[] {
  const names: string[] = [];
  const recorder = {
    registerTool(name: string) {
      names.push(name);
      // The SDK hands back a live tool handle; registrars may chain off it.
      return {
        enable() {},
        disable() {},
        remove() {},
        update() {},
      };
    },
  };

  registerMemoryTools(
    recorder as unknown as McpServer,
    // Never dereferenced: registration stores handlers, it does not invoke them.
    {} as unknown as MemoryToolDependencies,
  );

  const unique = [...new Set(names)].sort();
  if (unique.length !== names.length) {
    const seen = new Set<string>();
    const duplicates = [...new Set(names.filter((n) => !seen.add(n)))].sort();
    throw new Error(
      `server/tools registers duplicate tool name(s): ${duplicates.join(", ")}`,
    );
  }
  if (unique.length === 0) {
    throw new Error(
      "server/tools registered zero tools -- the registry walk is broken, not empty",
    );
  }
  return unique;
}

export const REWRITE_REGISTERED_TOOLS: readonly string[] =
  collectRegisteredTools();
