// Tests for the provider-neutral core01 deploy ref gate
// (scripts/deploy-ref-gate.ts). These exercise ONLY the pure decision function
// and the env-input assembly. They never load an env file, run migrations,
// touch launchctl, mkdir a runtime dir, or reach production state — the whole
// point of extracting the gate into a pure module.
import { describe, it, expect } from "bun:test";
import {
  evaluateDeployGate,
  readGateInputsFromEnv,
} from "./deploy-ref-gate.ts";

const MAIN = "1111111111111111111111111111111111111111";
const STALE = "2222222222222222222222222222222222222222";

describe("evaluateDeployGate", () => {
  it("allows a manual dispatch from the current main tip (github)", () => {
    const result = evaluateDeployGate({
      provider: "github",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      headSha: MAIN,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(true);
  });

  it("allows a manual dispatch from the current main tip (forgejo)", () => {
    const result = evaluateDeployGate({
      provider: "forgejo",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      headSha: MAIN,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(true);
  });

  it("allows a version tag reachable from main", () => {
    const result = evaluateDeployGate({
      provider: "forgejo",
      event: "push",
      ref: "refs/tags/v0.1.1",
      headSha: STALE,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(true);
  });

  it("refuses a stale manual-dispatch commit that is not the main tip", () => {
    const result = evaluateDeployGate({
      provider: "github",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      headSha: STALE,
      mainSha: MAIN,
      // Even an ancestor of main must be refused for a manual dispatch: the
      // deploy must be the EXACT current tip.
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not the current main tip");
  });

  it("refuses a version tag outside main ancestry", () => {
    const result = evaluateDeployGate({
      provider: "forgejo",
      event: "push",
      ref: "refs/tags/v9.9.9",
      headSha: STALE,
      mainSha: MAIN,
      headReachableFromMain: false,
      isCi: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not reachable from main");
  });

  it("refuses an unsupported event", () => {
    const result = evaluateDeployGate({
      provider: "github",
      event: "pull_request",
      ref: "refs/heads/main",
      headSha: MAIN,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("unsupported trigger");
  });

  it("refuses a push to a non-tag ref", () => {
    const result = evaluateDeployGate({
      provider: "forgejo",
      event: "push",
      ref: "refs/heads/main",
      headSha: MAIN,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("unsupported trigger");
  });

  it("refuses a manual dispatch on a non-main branch ref", () => {
    const result = evaluateDeployGate({
      provider: "github",
      event: "workflow_dispatch",
      ref: "refs/heads/feat/x",
      headSha: MAIN,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("unsupported trigger");
  });

  it("refuses an unsupported provider", () => {
    const result = evaluateDeployGate({
      provider: "gitlab",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      headSha: MAIN,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("unsupported provider");
  });

  it("fails closed on missing provider metadata in CI", () => {
    const result = evaluateDeployGate({
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      headSha: MAIN,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("missing CI provider metadata");
  });

  it("fails closed on missing event metadata in CI", () => {
    const result = evaluateDeployGate({
      provider: "forgejo",
      ref: "refs/heads/main",
      headSha: MAIN,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("missing CI event metadata");
  });

  it("fails closed on missing ref metadata in CI", () => {
    const result = evaluateDeployGate({
      provider: "forgejo",
      event: "push",
      headSha: MAIN,
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("missing CI ref metadata");
  });

  it("fails closed on missing HEAD/main commit metadata in CI", () => {
    const noHead = evaluateDeployGate({
      provider: "github",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      mainSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(noHead.allowed).toBe(false);
    expect(noHead.reason).toContain("missing HEAD commit metadata");

    const noMain = evaluateDeployGate({
      provider: "github",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      headSha: MAIN,
      headReachableFromMain: true,
      isCi: true,
    });
    expect(noMain.allowed).toBe(false);
    expect(noMain.reason).toContain("missing main-tip commit metadata");
  });

  it("skips the gate outside CI (operator-run deploy)", () => {
    const result = evaluateDeployGate({ isCi: false });
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("ref gate skipped");
  });
});

describe("readGateInputsFromEnv", () => {
  const repoFacts = {
    headSha: MAIN,
    mainSha: MAIN,
    headReachableFromMain: true,
  };

  it("derives github provider from GITHUB_ACTIONS with GITHUB_* fallbacks", () => {
    const inputs = readGateInputsFromEnv(
      {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
      },
      repoFacts,
    );
    expect(inputs.provider).toBe("github");
    expect(inputs.event).toBe("workflow_dispatch");
    expect(inputs.ref).toBe("refs/heads/main");
    expect(inputs.isCi).toBe(true);
  });

  it("derives forgejo provider from FORGEJO_ACTIONS", () => {
    const inputs = readGateInputsFromEnv(
      {
        FORGEJO_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/tags/v1.0.0",
      },
      repoFacts,
    );
    expect(inputs.provider).toBe("forgejo");
    expect(inputs.isCi).toBe(true);
  });

  it("prefers explicit DEPLOY_* inputs over GitHub env fallbacks", () => {
    const inputs = readGateInputsFromEnv(
      {
        DEPLOY_PROVIDER: "forgejo",
        DEPLOY_EVENT_NAME: "push",
        DEPLOY_REF: "refs/tags/v2.0.0",
        // Stale GitHub mirror must be ignored when explicit inputs are set.
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
      },
      repoFacts,
    );
    expect(inputs.provider).toBe("forgejo");
    expect(inputs.event).toBe("push");
    expect(inputs.ref).toBe("refs/tags/v2.0.0");
    expect(inputs.isCi).toBe(true);
  });

  it("reports not-in-CI when no provider signal is present", () => {
    const inputs = readGateInputsFromEnv({}, repoFacts);
    expect(inputs.isCi).toBe(false);
    expect(inputs.provider).toBe("");
  });
});
