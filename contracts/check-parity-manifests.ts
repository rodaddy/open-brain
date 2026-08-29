// Manifest shapes and the loading/scanning helpers behind contracts/check-parity.ts.
// Split out of check-parity.ts (issue 864) so the checker itself stays under the
// server/ whole-file lint standard; nothing here changes behaviour.

export type Runtime = "both" | "python" | "ts";
export type PythonStatus = "implemented";
export type TsStatus = "pending" | "implemented" | "runtime-specific";

export interface Fixture {
  id: string;
  description: string;
  capability: string;
  runtime: Runtime;
  consumers: string[];
  request: Record<string, unknown>;
  expectation: Record<string, unknown>;
}

export interface CapabilityEntry {
  capability: string;
  python: PythonStatus;
  ts: TsStatus;
  reason?: string;
}

export interface ParityManifest {
  id: string;
  expected_fixture_ids: Record<string, Runtime>;
  capabilities: CapabilityEntry[];
  not_yet_extracted?: Array<{
    capability: string;
    scenario: string;
    reason: string;
  }>;
}

export interface ServerFixture {
  id: string;
  description: string;
  capability: string;
  providers: string[];
  auth: Record<string, unknown>;
  steps: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    capture?: Record<string, unknown>;
    expectation: Record<string, unknown>;
  }>;
}

export type ServerCapabilityStatus = "implemented" | "scaffold-declared";

export interface ServerParityManifest {
  id: string;
  expected_fixture_ids: string[];
  providers: string[];
  capabilities: string[];
  provider_capability_status: Record<string, Record<string, ServerCapabilityStatus>>;
}

export interface ServerToolGap {
  tool: string;
  capability: string;
  reason: string;
}

export interface ServerToolGapMap {
  id: string;
  source: string;
  registered_tool_count: number;
  fixture_covered_tool_count: number;
  without_parity_fixture_count: number;
  fixture_covered_tools: string[];
  without_parity_fixture: ServerToolGap[];
}

const PLACEHOLDER_REASONS = new Set(["-", "n/a", "na", "none", "todo", "tbd"]);

export const CONSUMER_ALLOWLIST = new Set(["python", "ts"]);

export function isPlaceholderReason(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return !normalized || PLACEHOLDER_REASONS.has(normalized);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Registrations live in src/tools/ and, as issue 864 moves each one down, in
// server/tools/. An L5 adapter left behind in src/tools/ is a bare `export *`
// and carries no tool-name literal, so scanning src/tools/ alone silently
// loses every moved registration. Both directories feed the same set with the
// same pattern, so a tool seen in both is still counted once.
export async function collectRegisteredTools(
  dir: URL,
  into: Set<string>,
): Promise<void> {
  const glob = new Bun.Glob("*.ts");
  for await (const name of glob.scan({ cwd: dir.pathname, onlyFiles: true })) {
    const source = await Bun.file(new URL(name, dir)).text();
    for (const match of source.matchAll(
      /server\.registerTool\(\s*["'`]([^"'`]+)["'`]/g,
    )) {
      if (match[1]) into.add(match[1]);
    }
  }
}

export async function readJson<T>(url: URL): Promise<T> {
  try {
    return (await Bun.file(url).json()) as T;
  } catch (error) {
    throw new Error(`${url.pathname}: ${String(error)}`);
  }
}
