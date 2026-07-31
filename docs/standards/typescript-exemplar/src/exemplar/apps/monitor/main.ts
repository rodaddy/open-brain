/**
 * Monitor entry point.
 *
 * WHAT AN ENTRY POINT IS FOR, AND WHAT IT MUST NOT DO
 *
 * This is the ONLY place that constructs things: settings, logger, store,
 * database, service, server. Everything below receives what it needs as an
 * argument. That is what makes the rest of the app testable without a
 * filesystem, a port, or a clock -- and why no module below this one calls
 * `loadSettings()` or `createLogger()` for itself.
 *
 * It is also the only place that installs signal handlers and the only place
 * that calls `process.exit`.
 *
 * Run it: `npm run monitor`
 */

import { join } from "node:path";

import { loadSettings, PROJECT_ROOT } from "../../config.ts";
import { Database } from "../../db/database.ts";
import { createLogger } from "../../utils/logging.ts";
import { createApi } from "./api.ts";
import { MonitorService } from "./service.ts";
import { StateStore } from "./store.ts";

/**
 * Wire everything together and run until a signal arrives.
 *
 * @returns Resolves when shutdown is complete.
 */
async function main(): Promise<void> {
  // FAIL FAST. An invalid configuration throws here, before a port is bound or
  // a file is opened, with the offending field named. A service that starts on
  // bad config fails later, in production, pointing at a symptom.
  const settings = loadSettings();

  const logger = createLogger({
    service: "monitor",
    level: settings.logging.level,
    ...(settings.logging.file === null
      ? {}
      : { filePath: join(PROJECT_ROOT, settings.logging.file) }),
    pretty: settings.logging.pretty,
  });

  const database =
    settings.database.path === ":memory:"
      ? new Database(":memory:", logger)
      : new Database(join(PROJECT_ROOT, settings.database.path), logger);

  const store = new StateStore(
    join(PROJECT_ROOT, "data", "monitor-state.json"),
    logger,
  );
  const service = new MonitorService({ settings, logger, store, database });

  service.hydrate();
  service.start();

  const server = createApi({ service, logger, port: settings.ports.monitor });
  server.listen(settings.ports.monitor, () => {
    logger.info({ port: settings.ports.monitor }, "monitor api listening");
  });

  // Graceful shutdown. Without this, SIGTERM kills the process mid-write and
  // the state file is whatever the OS had flushed -- the exact durability
  // problem store.ts works to avoid, reintroduced at the last moment.
  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      logger.info({ signal }, "shutting down");
      service.stop();
      server.close(() => {
        database.close();
        resolve();
      });
    };

    process.once("SIGINT", () => {
      shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      shutdown("SIGTERM");
    });
  });

  logger.info("monitor stopped cleanly");
}

// Top-level failures must be loud and must set a non-zero exit code, or a
// supervisor sees a clean exit and does not restart.
main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- the logger may be what failed
  console.error("FATAL:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
