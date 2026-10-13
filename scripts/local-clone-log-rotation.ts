/**
 * Bounded output for the local-clone server child (issues 1526 and 754).
 *
 * Split out of scripts/local-clone.ts so the launcher stays under the file
 * size cap; the launcher's production spawn is the only production caller.
 */
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  createRotatingFileSink,
  type RotatingFileSink,
} from "../server/logging/rotating-file.ts";

/**
 * Env key naming the directory for the server child's rotated output. The
 * autostart wrapper sets it; unset (a hand-run `--start`) keeps the child on
 * the launcher's own stdio.
 */
export const LOCAL_CLONE_LOG_DIR_KEY = "OPENBRAIN_LOCAL_CLONE_LOG_DIR";

/**
 * Copy one readable stream into a rotating file sink, a line at a time.
 *
 * The sink appends whole lines, so a chunk's trailing partial line is held
 * until its newline arrives (or the stream ends).
 */
function pipeStreamToSink(stream: Readable, sink: RotatingFileSink): Promise<void> {
  return new Promise((resolve) => {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) sink.write(line);
    });
    const finish = (): void => {
      if (pending.length > 0) sink.write(pending);
      pending = "";
      resolve();
    };
    stream.once("end", finish);
    stream.once("error", finish);
  });
}

/**
 * Route the server child's stdout/stderr into `autostart.out.log` /
 * `autostart.err.log` under `logDir` through the app's rotating file sink
 * (issues 1526 and 754), instead of launchd's unbounded redirect. Uses the
 * sink's own defaults -- 1 MB per file, 3 rolled files -- the same bound the
 * app logger applies (docs/decisions/log-rotation-is-app-config.md).
 *
 * @returns A promise that settles once both streams have ended.
 */
export function pipeChildOutputToRotatingLogs(
  child: { stdout: Readable | null; stderr: Readable | null },
  logDir: string,
): Promise<void> {
  const pipes: Promise<void>[] = [];
  if (child.stdout) {
    pipes.push(
      pipeStreamToSink(
        child.stdout,
        createRotatingFileSink({ path: join(logDir, "autostart.out.log") }),
      ),
    );
  }
  if (child.stderr) {
    pipes.push(
      pipeStreamToSink(
        child.stderr,
        createRotatingFileSink({ path: join(logDir, "autostart.err.log") }),
      ),
    );
  }
  return Promise.all(pipes).then(() => undefined);
}
