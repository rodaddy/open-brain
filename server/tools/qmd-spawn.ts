/**
 * The qmd subprocess seam: spawning a qmd child and racing it against a
 * timeout, with BOTH arms cancelling whatever the other one armed.
 *
 * WHY THIS IS ITS OWN MODULE. The race used to live inline in `search-all.ts`,
 * where its correctness rested on one `clearTimeout` and a comment explaining
 * why. Issue 751 moves the runtime off Bun, and under `node:child_process` the
 * child's exit arrives as a 'close' EVENT rather than an `.exited` promise --
 * which adds a SECOND thing that leaks if the losing arm is not cleaned up. A
 * property that two independent hazards can break belongs behind one boundary
 * that owns both, so the done-means checker can execute it rather than grep it
 * (`scripts/done-means/751-no-bun-spawn-server.race.driver.ts`).
 *
 * THE HAZARD, in the words of the incident it came from: "The timer handle is
 * held outside the race so the winner can cancel the loser. Without the
 * clearTimeout below, a subprocess that finishes first leaves the timer armed
 * and it fires later, against an already-settled race -- after the test that
 * started it has ended. That is how #608/#632 surfaced: `Unhandled error
 * between tests` with `0 fail`, exit 1."
 *
 * The listener route is the same failure with a different handle: an arm built
 * on `child.on('close', ...)` that is never detached when the TIMEOUT wins
 * leaves a listener on a live emitter, and the child's later exit runs
 * settlement code after the caller has moved on.
 *
 * So: `raceWithTimeout` cancels the timer when the child wins, and removes
 * every listener it attached when the timeout wins. Neither arm can outlive
 * the race.
 */
import { spawn } from "node:child_process";

/**
 * The child handle this module races.
 *
 * Structurally typed rather than pinned to `ChildProcessWithoutNullStreams`, so
 * a test double can supply only the fields the race actually reads. That is
 * deliberate: `langfuse-tracing-fixtures.ts` supplies exactly such a double,
 * and pinning this to the concrete Node class would force the double to
 * implement the whole `ChildProcess` surface to stand in for four fields.
 */
export interface QmdChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  killed?: boolean;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/** The settled result of one qmd run, however the race ended. */
export interface QmdOutcome {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
}

/** How a qmd child is created. Injectable so a test can stand one in. */
export type QmdSpawn = (command: string[]) => QmdChild;

/**
 * Spawn a qmd child with both pipes open.
 *
 * `stderr` is piped rather than ignored because the race drains it: a chatty
 * child whose stderr pipe fills its ~64 KB OS buffer blocks mid-write, never
 * flushes stdout's EOF, and never exits.
 */
export const spawnQmd: QmdSpawn = (command: string[]): QmdChild => {
  const [file, ...args] = command;
  if (file === undefined) throw new Error("spawnQmd requires a command");
  // stdin is "ignore": qmd takes its query in argv, so the child needs no
  // input, and leaving a stdin pipe open is one more handle to close. The
  // return already satisfies `QmdChild` structurally -- no cast is needed, and
  // asserting one here would only hide a future mismatch.
  return spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
};

/** Read a stream to a string, resolving to "" for an absent or failed stream. */
function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise<string>((resolve) => {
    let text = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string | Buffer) => {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    stream.on("end", () => resolve(text));
    // A stream error degrades to whatever was read, matching the module's
    // fail-open contract: qmd going wrong drops qmd results, never the call.
    stream.on("error", () => resolve(text));
  });
}

/**
 * Race a qmd child against `timeoutMs`, cancelling whichever arm loses.
 *
 * Returns `timedOut: true` with `exitCode: -1` when the timeout wins, matching
 * the sentinel the caller already branches on.
 *
 * A child killed by a signal, or one that fails to launch, reports a NULL exit
 * code on Node. Null is mapped to a non-zero failure explicitly: passing it
 * through would let a caller's `code === 0` test read a killed child as
 * success, and `process.exit(null)` exits ZERO.
 */
export async function raceWithTimeout(
  child: QmdChild,
  timeoutMs: number,
): Promise<QmdOutcome> {
  // Both handles are held out here so the winning arm can cancel the loser.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const attached: Array<[string, (...args: unknown[]) => void]> = [];

  const detach = (): void => {
    const remove =
      child.off?.bind(child) ?? child.removeListener?.bind(child) ?? undefined;
    if (!remove) return;
    for (const [event, listener] of attached) remove(event, listener);
    attached.length = 0;
  };

  const childArm = (async (): Promise<QmdOutcome> => {
    // stdout and stderr are drained CONCURRENTLY with the exit wait. Reading
    // them serially deadlocks a child that fills the pipe it is not being read
    // from -- the same hazard rem-terra-transport.ts documents at its own site.
    const exited = new Promise<number>((resolve) => {
      const onClose = (...args: unknown[]): void => {
        const code = args[0];
        const signal = args[1];
        // Null code means killed-by-signal or failed-to-launch. Map it to a
        // non-zero failure rather than letting a falsy value read as success.
        resolve(typeof code === "number" ? code : signal ? 143 : 1);
      };
      const onError = (): void => resolve(1);
      child.on("close", onClose);
      child.on("error", onError);
      attached.push(["close", onClose], ["error", onError]);
    });

    const [stdout, , exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      exited,
    ]);
    return { stdout, exitCode, timedOut: false };
  })();

  const timeoutArm = new Promise<QmdOutcome>((resolve) => {
    timeoutHandle = setTimeout(() => {
      // Kill before resolving: an abandoned subprocess would hold its file
      // handles and its share of the box for the life of the server. `kill` is
      // guarded rather than called outright, because a partial test double
      // carries only the fields the happy path reads and `.kill()` on it throws
      // `TypeError: proc.kill is not a function` -- the exact error in #632.
      if (typeof child.kill === "function") child.kill();
      resolve({ stdout: "", exitCode: -1, timedOut: true });
    }, timeoutMs);
  });

  const outcome = await Promise.race([childArm, timeoutArm]);

  // Whichever arm won, neither handle may outlive this call:
  //   - the timer, so it cannot fire against an already-settled race (#608/#632)
  //   - the listeners, so a later child exit cannot run settlement code after
  //     the caller has moved on (the same failure, by the listener route)
  clearTimeout(timeoutHandle);
  detach();

  // The losing childArm promise is left to settle on its own; its listeners are
  // gone, so it can neither resolve into the caller nor keep the loop alive.
  void childArm.catch(() => {});

  return outcome;
}
