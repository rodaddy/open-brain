import type { EventEmitter } from "node:events";

/** The parts of a ChildProcess the wait reads; a fake emitter satisfies it in tests. */
export interface OutputSource extends EventEmitter {
  stdout: EventEmitter | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

/**
 * Resolves once the child's accumulated stdout contains `marker`; rejects if
 * the child exits or closes first. Purely event-driven (issue 1700): it checks
 * what `captured()` already holds, then re-checks on every later stdout chunk,
 * and owns no clock. The only deadline is the test runner's per-test timeout.
 *
 * `captured` must return everything read from stdout so far, accumulated by a
 * `data` listener registered before this one (the spawn site's), so each
 * chunk is in the buffer by the time this listener sees it.
 */
export function waitForOutput(
  child: OutputSource,
  captured: () => string,
  marker: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const exitedEarly = (code: number | null, signal: NodeJS.Signals | null) =>
      new Error(
        `child exited before printing ${JSON.stringify(marker)} (exit code ${code}, signal ${signal})`,
      );
    if (captured().includes(marker)) return resolve();
    if (child.exitCode !== null || child.signalCode !== null) {
      return reject(exitedEarly(child.exitCode, child.signalCode));
    }
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("exit", onEnd);
      child.off("close", onEnd);
    };
    const onData = () => {
      if (!captured().includes(marker)) return;
      cleanup();
      resolve();
    };
    const onEnd = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (captured().includes(marker)) resolve();
      else reject(exitedEarly(code, signal));
    };
    child.stdout?.on("data", onData);
    child.once("exit", onEnd);
    child.once("close", onEnd);
  });
}
