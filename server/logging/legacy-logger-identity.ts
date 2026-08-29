import os from "node:os";
import { createRotatingFileSink, type RotatingFileSink } from "./rotating-file.ts";
import { readLegacyLoggerSettings } from "./legacy-logger-settings.ts";

/**
 * Host and service identity, and the optional rotating file sink.
 *
 * All three were module-load constants reading the environment directly. Under
 * issue 864 the values arrive through the settings reader instead, and each is
 * memoized on FIRST USE rather than at module load — the same single read the
 * original performed, deferred to the moment the first line is emitted, so a
 * reader registered by the adapter or by `server/main.ts` during import is
 * already installed when the read happens.
 */

/**
 * Host identity stamped onto every line.
 *
 * Required by the shared observability envelope
 * (`_DOCS/CODING_STANDARDS.md`, `## Observability`): `service` and `host` are
 * the only two fields that become Loki labels, so every emitter on the fleet
 * must carry both or the per-host query surface has holes. Read once — a
 * process does not change hosts.
 */
let hostName: string | undefined;

export function getHostName(): string {
  if (hostName !== undefined) return hostName;
  const configured = readLegacyLoggerSettings().hostName?.trim();
  if (configured) {
    hostName = configured;
    return hostName;
  }
  try {
    hostName = os.hostname();
  } catch {
    // Deliberate fail-open: an unavailable hostname must degrade one label,
    // never prevent logging. Reporting it through the logger would recurse.
    hostName = "unknown";
  }
  return hostName;
}

/**
 * Rotating file sink path derivation (OB issue #193).
 *
 * Rotation is only single-writer safe, so when a worker name is set (the
 * two-worker launcher sets a distinct name per child) the effective path is
 * derived per worker automatically: `open-brain.log` becomes
 * `open-brain.<worker-name>.log`. Two workers inheriting the same configured
 * log file therefore never share an active file or rotation chain.
 */
export function deriveWorkerLogPath(
  path: string,
  workerName: string | undefined,
): string {
  const worker = workerName?.trim();
  if (!worker) return path;
  // Sanitize so the worker name can only alter the filename, never the dir.
  const safe = worker.replace(/[^A-Za-z0-9._-]/g, "_");
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const file = slash === -1 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return `${dir}${file}.${safe}`;
  return `${dir}${file.slice(0, dot)}.${safe}${file.slice(dot)}`;
}

/**
 * Parse an integer setting, falling back when below `min` or non-numeric.
 * The rotate threshold requires min 1 (a zero-byte threshold is meaningless
 * and would otherwise be silently coerced to the default deeper in the sink),
 * while a retained-file count of 0 is a real setting (keep only the active
 * file).
 */
function resolveBoundedInt(
  raw: string | undefined,
  min: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function resolveFileSink(): RotatingFileSink | undefined {
  const settings = readLegacyLoggerSettings();
  const configured = settings.logFile?.trim();
  if (!configured) return undefined;
  const path = deriveWorkerLogPath(configured, settings.workerName);
  return createRotatingFileSink({
    path,
    maxBytes: resolveBoundedInt(settings.logMaxBytes, 1, 1_000_000),
    maxFiles: resolveBoundedInt(settings.logMaxFiles, 0, 3),
  });
}

let fileSinkResolved = false;
let fileSink: RotatingFileSink | undefined;

/** The rotating file sink, resolved once on first use. */
export function getFileSink(): RotatingFileSink | undefined {
  if (fileSinkResolved) return fileSink;
  fileSinkResolved = true;
  fileSink = resolveFileSink();
  return fileSink;
}

/**
 * Service identity stamped onto every line. Part of the shared observability
 * envelope (`_DOCS/CODING_STANDARDS.md`, `## Observability`) so that logs from
 * every emitter on the fleet — applications and infrastructure alike — share one
 * queryable shape in Loki.
 *
 * Read once, on first use. When more than one worker writes, the worker name is
 * appended so lines are attributable to the process that emitted them, matching
 * how `deriveWorkerLogPath` separates their files.
 */
let serviceName: string | undefined;

export function getServiceName(): string {
  if (serviceName !== undefined) return serviceName;
  const settings = readLegacyLoggerSettings();
  const base = settings.serviceName?.trim() || "open-brain";
  const worker = settings.workerName?.trim();
  serviceName = worker ? `${base}.${worker}` : base;
  return serviceName;
}
