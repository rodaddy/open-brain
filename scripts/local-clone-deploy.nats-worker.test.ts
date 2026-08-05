/**
 * The local clone deploy must restart the NATS worker onto the runtime it just
 * swapped in.
 *
 * WHY THIS TEST EXISTS. The NATS worker is a SEPARATE launchd service from the
 * HTTP service (docs/core01-nats-worker-runbook.md "Boundary"), and both execute
 * out of the SAME runtime directory. `local-clone-deploy.sh` replaces that
 * directory wholesale, so a worker that is not restarted keeps running the
 * PREVIOUS revision's `scripts/run-nats-worker.ts` while the HTTP service serves
 * the new one -- two ingresses, one deploy, silently different code. core01's
 * deploy has always kickstarted its worker (`scripts/core01-deploy-local.sh`
 * NATS_WORKER_LABEL); the local clone script did not.
 *
 * The kickstart is deliberately NON-FATAL, so the assertions here are about the
 * ATTEMPT being made and reported, not about launchctl succeeding: these run on
 * a machine where the test label does not exist, exactly like the core01
 * integration test's `invalid.test.open-brain-nats-worker`.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEPLOY_SCRIPT = join(import.meta.dir, "local-clone-deploy.sh");

async function deployScriptSource(): Promise<string> {
  return await readFile(DEPLOY_SCRIPT, "utf8");
}

describe("local-clone-deploy.sh NATS worker restart", () => {
  it("defines a NATS worker label that defaults to empty", async () => {
    const source = await deployScriptSource();
    // Empty default: a clone with no worker installed must be unaffected, which
    // is what makes adding this safe for every existing caller.
    expect(source).toMatch(
      /NATS_WORKER_LABEL="\$\{OPENBRAIN_NATS_WORKER_LABEL:-\}"/,
    );
  });

  it("has a restart_nats_worker that no-ops when no label is configured", async () => {
    const source = await deployScriptSource();
    expect(source).toContain("restart_nats_worker() {");
    expect(source).toMatch(
      /restart_nats_worker\(\) \{[\s\S]*?\[\[ -n "\$NATS_WORKER_LABEL" \]\] \|\| return 0/,
    );
  });

  it("kickstarts the worker without aborting the deploy on failure", async () => {
    const source = await deployScriptSource();
    const body = source.slice(
      source.indexOf("restart_nats_worker() {"),
      source.indexOf("\n}", source.indexOf("restart_nats_worker() {")),
    );
    expect(body).toContain('launchctl kickstart -k "gui/${uid}/${NATS_WORKER_LABEL}"');
    // Non-fatal: warn, never `fatal`. A missing/optional second ingress must not
    // fail a deploy whose HTTP revision proof passed.
    expect(body).toContain("WARN: could not restart NATS worker");
    expect(body).not.toContain("fatal ");
  });

  it("restarts the worker on the deploy path and on BOTH rollback paths", async () => {
    const source = await deployScriptSource();
    const callSites = source.match(/^\s*restart_nats_worker$/gm) ?? [];
    // Three: the deploy swap, the failed-deploy rollback, and `--rollback`.
    // A rollback that restores the previous runtime under a worker still
    // running the failed revision is the same split-revision bug in reverse.
    expect(callSites).toHaveLength(3);
  });

  it("restarts the worker only after the runtime directory is swapped", async () => {
    const source = await deployScriptSource();
    const swapIndex = source.indexOf('mv "$STAGING_DIR" "$RUNTIME_DIR"');
    const deployRestartIndex = source.indexOf(
      "restart_nats_worker",
      swapIndex,
    );
    expect(swapIndex).toBeGreaterThan(-1);
    // Restarting before the swap would put the worker back on the OLD tree.
    expect(deployRestartIndex).toBeGreaterThan(swapIndex);
  });
});
