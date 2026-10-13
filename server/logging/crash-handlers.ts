/**
 * Explicit process crash visibility registration.
 *
 * Design authority: `_DOCS/STANDARDS-observability.md` requires crash logging;
 * that standard's allowlisted-category rule is deliberately departed from here
 * -- Rico ruling 2026-09-02, issue 1212: the crash line carries name, message
 * and stack; see docs/decisions/crash-log-carries-name-message-stack.md.
 * Registration is owned by the process entrypoint, `main()` in
 * `server/main.ts`, and has no import-time side effect. Not `startServer`: a
 * test that starts and stops the server in-process must not own listeners on
 * the one shared process.
 */
import type { Logger } from "pino";
import { sanitizeString } from "./sanitize.ts";

export interface CrashHandlerRegistration {
  unregister(): void;
}

/**
 * Project a crash cause into the three fields the crash line carries.
 *
 * A rejection can be thrown with any value, so the non-Error branch is not an
 * edge case: it names itself `non_error_rejection` rather than guessing a type,
 * and still carries the stringified value so the line is not empty. Every
 * string goes through `sanitizeString`, so a stack of any depth stays bounded
 * the same way every other logged string is.
 */
export function projectCrashReason(reason: unknown): {
  name: string;
  message: string;
  stack: string | null;
} {
  if (reason instanceof Error) {
    return {
      name: reason.name || "Error",
      message: sanitizeString(reason.message),
      stack: reason.stack ? sanitizeString(reason.stack) : null,
    };
  }
  return {
    name: "non_error_rejection",
    message: sanitizeString(String(reason)),
    stack: null,
  };
}

type Terminate = (code: number) => never;
const exitProcess: Terminate = (code) => process.exit(code);

/** Register process crash handlers. The caller decides when to install them. */
export function registerCrashHandlers(
  logger: Logger,
  terminate: Terminate = exitProcess,
): CrashHandlerRegistration {
  const reportAndExit = (event: string, error: unknown): never => {
    logger.fatal({ crash: projectCrashReason(error) }, event);
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
