/**
 * Explicit process crash visibility registration.
 *
 * Design authority: `_DOCS/STANDARDS-observability.md` requires crash logging;
 * registration is composition-root owned and has no import-time side effect.
 */
import type { Logger } from "pino";
import { sanitizeValue } from "./sanitize.ts";

export interface CrashHandlerRegistration {
  unregister(): void;
}

type Terminate = (code: number) => never;
const exitProcess: Terminate = (code) => process.exit(code);

/** Register process crash handlers. The caller decides when to install them. */
export function registerCrashHandlers(
  logger: Logger,
  terminate: Terminate = exitProcess,
): CrashHandlerRegistration {
  const reportAndExit = (event: string, error: unknown): never => {
    logger.fatal({ error: sanitizeValue(error) }, event);
    logger.flush();
    return terminate(1);
  };
  const onUncaughtException = (error: Error): void => {
    reportAndExit("process_uncaught_exception", error);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    reportAndExit("process_unhandled_rejection", reason);
  };
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  return {
    unregister: () => {
      process.off("uncaughtException", onUncaughtException);
      process.off("unhandledRejection", onUnhandledRejection);
    },
  };
}
