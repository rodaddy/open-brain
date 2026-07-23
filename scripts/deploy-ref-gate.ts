/**
 * Pre-mutation deploy ref gate for the core01 production deploy.
 *
 * This is the single decision point that decides whether a core01 deploy is
 * ALLOWED to mutate production, independent of which CI provider triggered it.
 * `scripts/core01-deploy-local.sh` calls this BEFORE any staging, swap,
 * launchd, or migration step. The gate must fail CLOSED: an unsupported,
 * stale, or unattested trigger refuses the deploy.
 *
 * Two providers are supported today:
 *   - github  (the active deploy path)
 *   - forgejo (prepared for a future repository-scoped core01 runner)
 *
 * Allowed triggers (identical policy for both providers):
 *   - a manual dispatch whose HEAD is EXACTLY the current main tip; or
 *   - a pushed `v*` tag whose target commit is REACHABLE from main.
 *
 * The provider/event/ref/main-relationship facts are gathered by the caller and
 * passed in explicitly. This module contains no git or environment access so it
 * can be unit-tested without touching a repo, env loading, launchctl, runtime
 * dirs, or production state.
 *
 * CLI usage (invoked by core01-deploy-local.sh):
 *   bun run scripts/deploy-ref-gate.ts
 * Inputs are read from the environment (see readGateInputsFromEnv). On an
 * allowed deploy it exits 0; otherwise it prints a FATAL reason and exits 1.
 */

export type DeployProvider = "github" | "forgejo";

export type DeployEvent = "workflow_dispatch" | "push" | (string & {});

export interface DeployGateInputs {
  /** CI provider that produced this run. */
  provider: DeployProvider | string;
  /** Normalized event name (workflow_dispatch or push). */
  event: DeployEvent;
  /** Full ref, e.g. refs/heads/main or refs/tags/v0.1.1. */
  ref: string;
  /** Commit being deployed (HEAD). */
  headSha: string;
  /** Current main-branch tip the deploy is validated against. */
  mainSha: string;
  /**
   * True when headSha is reachable from mainSha (an ancestor of, or equal to,
   * the main tip). The caller computes this from the real repo.
   */
  headReachableFromMain: boolean;
  /**
   * True when running inside a CI provider. Outside CI the gate is a no-op
   * (local/manual operator runs are trusted), matching the prior GitHub-only
   * behavior.
   */
  isCi: boolean;
}

export interface DeployGateResult {
  allowed: boolean;
  /** Human-readable reason, always set (success or refusal). */
  reason: string;
}

const SUPPORTED_PROVIDERS: readonly DeployProvider[] = ["github", "forgejo"];

function isVersionTagRef(ref: string): boolean {
  return ref.startsWith("refs/tags/v");
}

function isMainBranchRef(ref: string): boolean {
  return ref === "refs/heads/main";
}

/**
 * Decide whether a core01 deploy is allowed. Pure: no I/O, no git, no env.
 * Fails closed on any missing, unsupported, or stale metadata.
 */
export function evaluateDeployGate(
  inputs: Partial<DeployGateInputs>,
): DeployGateResult {
  // Outside CI the gate does not apply (operator-run deploys are trusted, as
  // in the original GitHub-only script). isCi must be explicitly false to skip.
  if (inputs.isCi === false) {
    return { allowed: true, reason: "not running in CI; ref gate skipped" };
  }

  const provider = inputs.provider;
  const event = inputs.event;
  const ref = inputs.ref;
  const headSha = inputs.headSha;
  const mainSha = inputs.mainSha;

  // Fail closed when any required CI metadata is missing. Do not guess.
  if (!provider) {
    return {
      allowed: false,
      reason: "refusing core01 deploy: missing CI provider metadata",
    };
  }
  if (!SUPPORTED_PROVIDERS.includes(provider as DeployProvider)) {
    return {
      allowed: false,
      reason:
        `refusing core01 deploy from unsupported provider: ${provider} ` +
        `(supported: ${SUPPORTED_PROVIDERS.join(", ")})`,
    };
  }
  if (!event) {
    return {
      allowed: false,
      reason: "refusing core01 deploy: missing CI event metadata",
    };
  }
  if (!ref) {
    return {
      allowed: false,
      reason: "refusing core01 deploy: missing CI ref metadata",
    };
  }
  if (!headSha) {
    return {
      allowed: false,
      reason: "refusing core01 deploy: missing HEAD commit metadata",
    };
  }
  if (!mainSha) {
    return {
      allowed: false,
      reason: "refusing core01 deploy: missing main-tip commit metadata",
    };
  }

  if (event === "workflow_dispatch" && isMainBranchRef(ref)) {
    if (headSha !== mainSha) {
      return {
        allowed: false,
        reason:
          "refusing manual core01 deploy because HEAD is not the current " +
          `main tip: head=${headSha} main=${mainSha}`,
      };
    }
    return {
      allowed: true,
      reason: `manual deploy from current main tip: ${headSha}`,
    };
  }

  if (event === "push" && isVersionTagRef(ref)) {
    if (!inputs.headReachableFromMain) {
      return {
        allowed: false,
        reason:
          "refusing tag core01 deploy because HEAD is not reachable from " +
          `main: ${headSha}`,
      };
    }
    return {
      allowed: true,
      reason: `tag deploy reachable from main: ref=${ref} head=${headSha}`,
    };
  }

  return {
    allowed: false,
    reason: `refusing core01 deploy from unsupported trigger: event=${event} ref=${ref}`,
  };
}

/**
 * Assemble gate inputs from the environment with backward-compatible GitHub
 * fallbacks. Provider-neutral inputs win; GitHub Actions env vars are used only
 * when the explicit inputs are absent. headSha/mainSha/headReachableFromMain
 * are supplied by the caller (the bash script computes them from the repo).
 */
export function readGateInputsFromEnv(
  env: Record<string, string | undefined>,
  repoFacts: {
    headSha: string;
    mainSha: string;
    headReachableFromMain: boolean;
  },
): DeployGateInputs {
  // Explicit provider-neutral inputs take precedence.
  const explicitProvider = env.DEPLOY_PROVIDER;
  const explicitEvent = env.DEPLOY_EVENT_NAME;
  const explicitRef = env.DEPLOY_REF;

  // Backward-compatible fallbacks. GitHub Actions sets GITHUB_ACTIONS=true and
  // GITHUB_EVENT_NAME/GITHUB_REF. Forgejo Actions sets FORGEJO_ACTIONS=true (and
  // mirrors GITHUB_* for compatibility), but a repository-scoped runner should
  // set DEPLOY_PROVIDER=forgejo explicitly so we never rely on the mirror.
  const githubCi = env.GITHUB_ACTIONS === "true";
  const forgejoCi = env.FORGEJO_ACTIONS === "true";

  let provider = explicitProvider;
  if (!provider) {
    if (forgejoCi) provider = "forgejo";
    else if (githubCi) provider = "github";
  }

  const isCi = Boolean(explicitProvider) || githubCi || forgejoCi;

  const event = explicitEvent ?? env.GITHUB_EVENT_NAME ?? "";
  const ref = explicitRef ?? env.GITHUB_REF ?? "";

  return {
    provider: provider ?? "",
    event,
    ref,
    headSha: repoFacts.headSha,
    mainSha: repoFacts.mainSha,
    headReachableFromMain: repoFacts.headReachableFromMain,
    isCi,
  };
}

/**
 * CLI entrypoint. Called by core01-deploy-local.sh, which has already gathered
 * the repo facts (HEAD sha, main tip sha, reachability) from the real git repo
 * and exported them, plus the provider/event/ref metadata. This process only
 * makes the ALLOW/REFUSE decision and exits accordingly. It performs no git,
 * env-file, launchctl, or runtime I/O.
 *
 * Required repo-fact env (set by the caller):
 *   DEPLOY_HEAD_SHA              HEAD commit
 *   DEPLOY_MAIN_SHA              current main tip
 *   DEPLOY_HEAD_REACHABLE_FROM_MAIN  "true" when HEAD is an ancestor of main
 */
function main(): void {
  const env = process.env;

  const inputs = readGateInputsFromEnv(env, {
    headSha: env.DEPLOY_HEAD_SHA ?? "",
    mainSha: env.DEPLOY_MAIN_SHA ?? "",
    headReachableFromMain: env.DEPLOY_HEAD_REACHABLE_FROM_MAIN === "true",
  });

  const result = evaluateDeployGate(inputs);

  if (!result.allowed) {
    console.error(`FATAL: ${result.reason}`);
    process.exit(1);
  }

  console.log(`deploy ref gate PASSED: ${result.reason}`);
}

if (import.meta.main) {
  main();
}
