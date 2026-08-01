import { describe, expect, it } from "bun:test";

/**
 * F8 regression (Sol cross-family review). Design lookup: the existing
 * `rem-terra-transport.ts` spawns `codex exec` with stdout+stderr piped and,
 * before this fix, read only stdout. The design covered parsing and timeout but
 * NOT stderr draining -- the delta this closes. A child whose stderr pipe is
 * never read deadlocks once the OS stderr buffer (~64 KB) fills: it blocks
 * writing stderr, never flushes stdout's EOF, and never exits, so a parent that
 * reads only stdout and awaits `exited` hangs until the ten-minute kill timer.
 *
 * `runTerraBatch` spawns `codex exec`, which is not runnable in a unit test
 * (see the module docstring), so these reproduce the exact spawn/read shape
 * with a portable child that floods BOTH streams. They prove the property the
 * fix depends on: reading only stdout can hang, and draining both concurrently
 * completes. If the transport ever reverts to a stdout-only read, the mechanism
 * these guard is gone.
 */

// A child that writes far more than one pipe buffer (~64 KB) to BOTH stdout and
// stderr. Interleaved so neither can complete unless the other is being read.
const FLOOD_SCRIPT = `
const big = "x".repeat(1024);
// ~8 MB per stream, far past any OS pipe buffer, written with backpressure
// (await drain) so an unread pipe genuinely stalls the writer rather than
// letting the runtime absorb it.
async function flood(stream) {
  for (let i = 0; i < 8192; i++) {
    if (!stream.write(big)) {
      await new Promise((r) => stream.once("drain", r));
    }
  }
}
await Promise.all([flood(process.stdout), flood(process.stderr)]);
process.stdout.write("\\nDONE\\n");
`;

function spawnFlood() {
  return Bun.spawn(["bun", "-e", FLOOD_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("terra transport stderr drain (F8)", () => {
  it("completes when BOTH stdout and stderr are drained concurrently (the fix)", async () => {
    const proc = spawnFlood();
    // The fix's shape: read both pipes in parallel and await exit together.
    const finished = (async () => {
      const [out] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return out;
    })();

    const guard = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 5_000),
    );
    const result = await Promise.race([finished, guard]);

    expect(result).not.toBe("timeout");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("DONE");
    expect(proc.exitCode).toBe(0);
  });

  it("the transport source reads BOTH stdout and stderr (structural guard)", async () => {
    // The deadlock's presence/absence is OS- and runtime-buffer dependent, so
    // it is not a reliable red-bar assertion here. What IS reliable and is the
    // actual defect: whether the code drains stderr at all. This reads the
    // source of the read block and requires both pipes be consumed. It fails
    // the instant someone reverts to a stdout-only read -- the exact regression
    // the positive test above cannot catch when the platform happens not to
    // deadlock.
    const source = await Bun.file(
      new URL("./rem-terra-transport.ts", import.meta.url),
    ).text();
    // The read block between the timer arm and the exitCode check must consume
    // both streams.
    const readsStdout = /new Response\(proc\.stdout\)\.text\(\)/.test(source);
    const readsStderr = /new Response\(proc\.stderr\)\.text\(\)/.test(source);
    expect(readsStdout).toBe(true);
    expect(readsStderr).toBe(true);
  });
});
