/**
 * Current state, persisted as one JSON file.
 *
 * WHY A JSON FILE AND NOT THE DATABASE
 *
 * This holds CURRENT state -- one record per target, rewritten every round,
 * read whole at startup. That access pattern is exactly what a file is good at:
 * bounded size, single writer, human-readable during an incident, and no
 * operational dependency to stand up before the monitor can run.
 *
 * `db/` holds HISTORY, which is the opposite pattern. See `db/index.ts` for the
 * other half of this argument. Reaching for a database here would be as wrong
 * as reaching for a JSON file there.
 *
 * WHY THE WRITE IS THIS COMPLICATED
 *
 * `writeFileSync` truncates the target and then writes. Lose power in between
 * -- or crash, or get OOM-killed -- and the file on disk is empty or truncated,
 * so the monitor restarts with no state at all.
 *
 * The fix is write-to-temp, fsync, rename:
 *
 *   1. write the new content to a sibling temp file
 *   2. fsync THAT file, so its bytes are on the device
 *   3. rename over the target -- atomic within a filesystem, so a reader sees
 *      either the whole old file or the whole new one, never a partial
 *   4. fsync the DIRECTORY, so the rename itself is durable
 *
 * Step 4 is the one everybody omits: without it the rename can be lost even
 * though the data was flushed, leaving the old file in place.
 *
 * The macOS caveat from the Python exemplar applies to Node too: `fsync` on
 * macOS does NOT flush the drive's own write cache, only the OS buffer. Full
 * durability needs `F_FULLFSYNC`, which Node does not expose. This is stated
 * rather than glossed -- the guarantee here is "atomic", and "durable against
 * OS crash", but not "durable against sudden power loss on macOS".
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { TargetState } from "../../models/check.ts";

/** The file's whole shape, so a partial read is a validation error not a crash. */
const StoreFile = z.object({
  version: z.literal(1),
  states: z.array(TargetState),
});
type StoreFile = z.infer<typeof StoreFile>;

/** Flush a file's contents to the device, as far as this platform allows. */
function flushFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Flush a directory entry, so a rename survives a crash.
 *
 * Best-effort by design: opening a directory for fsync is not permitted on
 * every platform (Windows notably), and failing the whole write because the
 * extra safety step is unavailable would be worse than proceeding without it.
 * The failure is logged rather than swallowed.
 */
function flushDirectory(path: string, logger: Logger | undefined): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    // Cannot open a directory on this platform. Not an error worth failing on;
    // the rename still happened and the data is still flushed.
    logger?.debug({ path }, "STORE: directory fsync unavailable on this platform");
    return;
  }
  try {
    fsyncSync(fd);
  } catch (error: unknown) {
    logger?.debug(
      { path, err: error instanceof Error ? error : new Error(String(error)) },
      "STORE: directory fsync failed",
    );
  } finally {
    closeSync(fd);
  }
}

/** Reads and writes the monitor's current-state file. */
export class StateStore {
  readonly #path: string;
  readonly #logger: Logger | undefined;

  constructor(path: string, logger?: Logger) {
    this.#path = path;
    this.#logger = logger;
    mkdirSync(dirname(path), { recursive: true });
  }

  /**
   * Load persisted state.
   *
   * @returns The stored states, or an empty array on a first run.
   * @throws {Error} If the file exists but is malformed -- a corrupt state file
   *   is a real fault, and starting fresh would silently discard the history
   *   that explains why a target is currently down.
   */
  load(): TargetState[] {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.#logger?.debug({ path: this.#path }, "STORE: no state file yet");
        return [];
      }
      throw error;
    }

    const parsed = StoreFile.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(
        `State file ${this.#path} is malformed: ${parsed.error.issues[0]?.message ?? "unknown"}. ` +
          "ACTION REQUIRED: inspect it, then delete it to start fresh if the contents are unrecoverable.",
      );
    }
    return parsed.data.states;
  }

  /**
   * Persist state atomically.
   *
   * @param states - The complete set. This is a whole-file rewrite, not a
   *   merge: partial writes are what make a state file drift out of sync with
   *   reality.
   */
  save(states: TargetState[]): void {
    const payload: StoreFile = { version: 1, states };
    const temp = join(dirname(this.#path), `.${Date.now().toString(36)}.tmp`);

    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    flushFile(temp);
    renameSync(temp, this.#path);
    flushDirectory(dirname(this.#path), this.#logger);

    this.#logger?.debug({ path: this.#path, count: states.length }, "STORE: saved");
  }
}
