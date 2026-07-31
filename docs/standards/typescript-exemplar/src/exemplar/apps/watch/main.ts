/**
 * Watch -- react to filesystem changes, debounced.
 *
 * WHY THIS APP IS IN THE EXEMPLAR
 *
 * It demonstrates the pattern the monitor does not: an EVENT-DRIVEN loop rather
 * than a timed one, and the debounce that every event-driven loop eventually
 * needs. A single file save commonly emits three or four `change` events (write,
 * truncate, attribute update, editor swap-file rename), so the naive handler
 * runs four times per save. Debouncing is not an optimization here -- without
 * it the app is simply wrong.
 *
 * WHY `fs.watch` AND NOT CHOKIDAR
 *
 * `## LAW: do not hand-roll a solved problem` ranks stdlib above a third-party
 * library. `fs.watch` with `recursive: true` is supported on macOS and Windows
 * and, since Node 20, on Linux. Chokidar exists because that was NOT true for
 * years and because it normalizes event names across platforms -- real value,
 * but for one directory and a debounce it is a dependency replacing fifteen
 * lines.
 *
 * The honest caveat: `fs.watch` event NAMES differ by platform ("rename" fires
 * for creation on some, deletion on others). This app deliberately ignores the
 * event name and reacts to "something changed under this path", which is the
 * portable subset. An app that must distinguish create from delete should use
 * chokidar -- and that is the line where the calculus flips.
 *
 * Run it: `npm run watch`
 */

import { watch } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";

import { loadSettings, PROJECT_ROOT, type Settings } from "../../config.ts";
import { createLogger, withLogContext } from "../../utils/logging.ts";
import { iso, utcNow } from "../../utils/datetime.ts";

/** What the watcher needs. Injected, so tests need no real filesystem events. */
export interface WatchDeps {
  settings: Settings;
  logger: Logger;
  /** Called once per settled burst. */
  onChange: (paths: string[]) => void | Promise<void>;
}

/**
 * Collects events and fires once a burst goes quiet.
 *
 * Exported and constructed with plain values so the debounce can be tested by
 * calling `notice()` directly -- no filesystem, no timers to wait on beyond the
 * debounce itself.
 */
export class DebouncedWatcher {
  readonly #deps: WatchDeps;
  readonly #pending = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #closers: (() => void)[] = [];

  constructor(deps: WatchDeps) {
    this.#deps = deps;
  }

  /**
   * Record that a path changed, and (re)start the quiet timer.
   *
   * @param path - What changed.
   */
  notice(path: string): void {
    this.#pending.add(path);

    // Restart, not extend: each new event pushes the deadline out, so a burst
    // fires once after it stops rather than once per event.
    if (this.#timer !== undefined) clearTimeout(this.#timer);

    this.#timer = setTimeout(() => {
      const paths = [...this.#pending];
      this.#pending.clear();
      this.#timer = undefined;

      void withLogContext(
        { correlationId: `watch-${Date.now().toString(36)}` },
        async (): Promise<void> => {
          this.#deps.logger.info(
            { count: paths.length, at: iso(utcNow()) },
            "change burst settled",
          );
          try {
            await this.#deps.onChange(paths);
          } catch (error: unknown) {
            // Logged and contained. A throwing handler must not kill the
            // watcher -- the whole point is that it keeps running.
            this.#deps.logger.error(
              { err: error instanceof Error ? error : new Error(String(error)) },
              "change handler failed",
            );
          }
        },
      );
    }, this.#deps.settings.watch.debounceMs);
  }

  /** Begin watching every configured path. */
  start(): void {
    for (const relative of this.#deps.settings.watch.paths) {
      const absolute = join(PROJECT_ROOT, relative);
      const watcher = watch(absolute, { recursive: true }, (_event, filename) => {
        this.notice(filename === null ? absolute : join(absolute, filename));
      });

      watcher.on("error", (error: unknown) => {
        this.#deps.logger.error(
          {
            path: absolute,
            err: error instanceof Error ? error : new Error(String(error)),
          },
          "watcher error",
        );
      });

      this.#closers.push(() => {
        watcher.close();
      });
      this.#deps.logger.info({ path: absolute }, "watching");
    }
  }

  /** Stop watching and cancel any pending burst. */
  stop(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const close of this.#closers) close();
    this.#closers = [];
    this.#deps.logger.info("watcher stopped");
  }
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const logger = createLogger({
    service: "watch",
    level: settings.logging.level,
    ...(settings.logging.file === null
      ? {}
      : { filePath: join(PROJECT_ROOT, settings.logging.file) }),
    pretty: settings.logging.pretty,
  });

  const watcher = new DebouncedWatcher({
    settings,
    logger,
    onChange: (paths) => {
      logger.info({ paths }, "would react to these changes");
    },
  });

  watcher.start();

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      watcher.stop();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

// Only run when executed directly, so tests can import DebouncedWatcher.
if (process.argv[1]?.endsWith("watch/main.ts") === true) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- the logger may be what failed
    console.error("FATAL:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
