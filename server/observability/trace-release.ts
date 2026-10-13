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
 * rather than re-implementing the parse. That parser is INJECTED rather than
 * imported (#1210): observability is a leaf tier, and reaching sideways into
 * `transport` for it made the tracing lane un-loadable without the transport
 * tier behind it. The composition root owns the edge instead.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

interface RepoReleaseDeps {
  readStamp?: () => string | undefined;
  /**
   * Parser for the deploy-stamp format, supplied by the caller.
   *
   * Structural rather than `typeof readDeployedRevision` on purpose: naming the
   * transport symbol in the type is the same cross-tier edge as importing it at
   * runtime, just deferred to the typechecker. REQUIRED, so there is no default
   * that quietly reinstates the import (#1210, #1211).
   */
  parseStamp: DeployStampParser;
  resolveGit?: () => string | undefined;
}

/**
 * The one thing observability needs from the deploy-stamp owner: turn the raw
 * stamp text into a short SHA, or `undefined` for a tree that was never
 * deployed. Declared here and re-used by `trace-sink.ts` so the two files agree
 * on the seam without either naming `server/transport`.
 */
export type DeployStampParser = (
  readStamp: () => string | undefined,
) => string | undefined;

/** Resolve the deploy stamp first, then a development checkout as fallback. */
export function resolveRepoRelease(deps: RepoReleaseDeps): string | undefined {
  try {
    const stamped = deps.parseStamp(deps.readStamp ?? readRuntimeDeployStamp);
    if (stamped !== undefined) return stamped;
    return (deps.resolveGit ?? resolveGitCheckoutRelease)();
  } catch {
    // Deliberate fail-open: not knowing the release is never a reason to lose
    // tracing. Both sources are optional by design — readDeployedRevision
    // (transport/server-identity.ts:260) already returns undefined for a tree
    // that was never deployed.
    return undefined;
  }
}

export function readRuntimeDeployStamp(): string | undefined {
  return readFileSync(new URL("../../.deployed-revision", import.meta.url), "utf8");
}

function resolveGitCheckoutRelease(): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: REV_PARSE_TIMEOUT_MS,
  });
  // Bun's `success` was false for BOTH a nonzero exit and a kill by signal.
  // Node reports those as `status: N` and `status: null` respectively, so
  // `status === 0` is the single comparison covering both — and it also
  // covers a spawn that never started, which leaves `status` null too.
  if (result.status !== 0) return undefined;
  return result.stdout?.trim() || undefined;
}

/**
 * The process's release, resolved once and cached across every caller.
 *
 * The memo is keyed on nothing, so THE FIRST CALLER'S PARSER WINS: a second
 * call with a different `parseStamp` returns the first call's answer rather
 * than re-resolving. That is the existing behavior preserved verbatim -- the
 * SHA cannot change under a running process, and re-resolving would put a
 * `git rev-parse` fork back on the request path. In practice there is one
 * caller, `defaultSinkFactory`, and it is fed from the composition root.
 */
export function repoRelease(deps: RepoReleaseDeps): string | undefined {
  if (cachedRelease !== null) return cachedRelease;
  cachedRelease = resolveRepoRelease(deps);
  return cachedRelease;
}
