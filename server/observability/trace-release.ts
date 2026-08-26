/**
 * Release identity for the tracing lane: which commit is this process running?
 *
 * Langfuse's `release` is what turns "cost went up" into "cost went up at THIS
 * commit"; #560 measured it empty on 100% of traces. Split out of
 * `langfuse-tracing.ts` so the resolution order — deploy stamp first, git
 * checkout second — is readable on its own and testable without the SDK.
 *
 * The deploy stamp is PARSED by `readDeployedRevision`
 * (`server/transport/server-identity.ts`), the existing owner of that format;
 * this module supplies the file read and the development-checkout fallback
 * rather than re-implementing the parse.
 */
import { readFileSync } from "node:fs";
import { readDeployedRevision } from "../transport/server-identity.ts";

/**
 * How long `git rev-parse` may take before the release is treated as unknown.
 *
 * Short by intent: resolving the SHA is an enrichment, so a hung git call must
 * never be what delays server startup. The timeout expiring costs one metadata
 * field and nothing else.
 */
const REV_PARSE_TIMEOUT_MS = 2_000;

/**
 * The short git SHA of the checkout this process runs from, or `undefined`.
 *
 * Resolved ONCE, lazily, and cached for the process: the SHA cannot change
 * under a running process, and a subprocess per emit would put a fork on the
 * request path — which is the one thing this whole lane is built not to do.
 *
 * `undefined` when neither the deploy stamp nor a git checkout can identify the
 * SHA. Deliberately NOT a placeholder like `"unknown"`: an omitted release reads
 * as absent, while a placeholder groups every unversioned trace together as
 * though they shared a commit.
 */
let cachedRelease: string | undefined | null = null;

export interface RepoReleaseDeps {
  readStamp?: () => string | undefined;
  parseStamp?: typeof readDeployedRevision;
  resolveGit?: () => string | undefined;
}

/** Resolve the deploy stamp first, then a development checkout as fallback. */
export function resolveRepoRelease(
  deps: RepoReleaseDeps = {},
): string | undefined {
  try {
    const parseStamp = deps.parseStamp ?? readDeployedRevision;
    const stamped = parseStamp(deps.readStamp ?? readRuntimeDeployStamp);
    if (stamped !== undefined) return stamped;
    return (deps.resolveGit ?? resolveGitCheckoutRelease)();
  } catch {
    // Not knowing the release is never a reason to lose tracing.
    return undefined;
  }
}

export function readRuntimeDeployStamp(): string | undefined {
  return readFileSync(
    new URL("../../.deployed-revision", import.meta.url),
    "utf8",
  );
}

function resolveGitCheckoutRelease(): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--short", "HEAD"],
    stdout: "pipe",
    stderr: "ignore",
    timeout: REV_PARSE_TIMEOUT_MS,
  });
  if (!result.success) return undefined;
  return result.stdout.toString().trim() || undefined;
}

export function repoRelease(): string | undefined {
  if (cachedRelease !== null) return cachedRelease;
  cachedRelease = resolveRepoRelease();
  return cachedRelease;
}
