/**
 * Run the `uv run openbrain-capture-stop` child for the Langfuse egress gate.
 *
 * Extracted from scripts/eval-langfuse-egress.ts during the bun -> Node 24
 * migration (issue 751, cluster C). Spawning a child and grading its exit is
 * a subprocess concern rather than egress logic, and inlining it pushed that
 * module past the repo's 500-code-line ceiling.
 */

import { spawn } from "node:child_process";

export interface CaptureStopResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run capture-stop, feeding `payload` on stdin, and RESOLVE with the exit code
 * rather than rejecting on a non-zero one -- the caller grades that code as
 * evidence (the `capture_exit` check), so a rejecting wrapper would be wrong.
 *
 * node's spawn is used rather than execFile because the child is fed on stdin,
 * which execFile cannot do.
 *
 * `close` reports the code as null when the child is killed by a signal, and
 * an exec failure (binary missing) emits `error` and may never emit `close` at
 * all. Both normalize to -1, so a child that never ran can never be graded as
 * a clean exit.
 */
export function runCaptureStop(opts: {
  cwd: string;
  env: Record<string, string>;
  payload: string;
}): Promise<CaptureStopResult> {
  return new Promise((resolve) => {
    const child = spawn("uv", ["run", "openbrain-capture-stop"], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let settled = false;
    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };
    child.on("error", (error) => {
      stderr += `${stderr ? "\n" : ""}${error.message}`;
      settle(-1);
    });
    child.on("close", (code) => settle(code ?? -1));
    // EPIPE when the child exits before reading its input must not reject the
    // whole run: the close handler above already carries the verdict.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.payload);
  });
}
