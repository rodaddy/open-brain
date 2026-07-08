// Single source of truth for qmd entrypoint path resolution.
//
// Both the real qmd caller (src/tools/search-all.ts) and the operator doctor
// (src/operator-doctor.ts) MUST consume resolveQmdPath() so their view of the
// qmd binary location can never diverge. The default matches the documented
// prod layout on core01.
export const DEFAULT_QMD_PATH = "/opt/qmd/src/qmd.ts";

export interface ResolvedQmdPath {
  path: string;
  source: "env" | "default";
}

export function resolveQmdPath(
  env: Record<string, string | undefined> = process.env,
): ResolvedQmdPath {
  // Mirror the historical `process.env.QMD_PATH ?? DEFAULT_QMD_PATH` exactly
  // (no trimming) so search_all behavior is unchanged.
  if (env.QMD_PATH === undefined) {
    return { path: DEFAULT_QMD_PATH, source: "default" };
  }
  return { path: env.QMD_PATH, source: "env" };
}
