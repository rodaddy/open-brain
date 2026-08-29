// L5 adapter (issue 864): legacy call form over server/capture/drop-folder-collector.ts; retired with src/ at L6.
import {
  collectDropFolder as collectWithBounds,
  discoverFiles as discoverWithBounds,
  DEFAULT_DROP_COLLECTOR_BOUNDS,
  type DropCollectorBounds,
} from "../server/capture/drop-folder-collector.ts";

export * from "../server/capture/drop-folder-collector.ts";

/**
 * The scan bounds the legacy call form expects to come from the environment.
 *
 * The server/ collector takes them as an options field filled by the
 * composition root. src/ callers and their tests still flip
 * `DROP_COLLECTOR_*` at call time, so this adapter reads them here, per call,
 * exactly as the pre-move module did.
 */
function boundedInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function envBounds(): DropCollectorBounds {
  const scanEntries = boundedInt("DROP_COLLECTOR_MAX_SCAN_ENTRIES", 0);
  return {
    files: boundedInt("DROP_COLLECTOR_MAX_FILES", DEFAULT_DROP_COLLECTOR_BOUNDS.files),
    fileBytes: boundedInt(
      "DROP_COLLECTOR_MAX_FILE_BYTES",
      DEFAULT_DROP_COLLECTOR_BOUNDS.fileBytes,
    ),
    totalBytes: boundedInt(
      "DROP_COLLECTOR_MAX_TOTAL_BYTES",
      DEFAULT_DROP_COLLECTOR_BOUNDS.totalBytes,
    ),
    depth: boundedInt("DROP_COLLECTOR_MAX_DEPTH", DEFAULT_DROP_COLLECTOR_BOUNDS.depth),
    ...(scanEntries > 0 ? { scanEntries } : {}),
  };
}

export function maxFiles(): number {
  return envBounds().files;
}

export function maxFileBytes(): number {
  return envBounds().fileBytes;
}

export function maxTotalBytes(): number {
  return envBounds().totalBytes;
}

export function maxDepth(): number {
  return envBounds().depth;
}

/** The legacy three-argument form: bounds came from the environment, not a parameter. */
export function collectDropFolder(
  ...args: Parameters<typeof collectWithBounds> extends [
    infer D,
    infer A,
    infer I,
    ...unknown[],
  ]
    ? [deps: D, auth: A, input: I]
    : never
): ReturnType<typeof collectWithBounds> {
  return collectWithBounds(args[0], args[1], args[2], { bounds: envBounds() });
}

/** The legacy two-argument form: depth and scan entries came from the environment. */
export function discoverFiles(
  realRoot: string,
  limit: number,
): ReturnType<typeof discoverWithBounds> {
  const bounds = envBounds();
  return discoverWithBounds(realRoot, limit, {
    depth: bounds.depth,
    ...(bounds.scanEntries === undefined ? {} : { scanEntries: bounds.scanEntries }),
  });
}
