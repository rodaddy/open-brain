// Single source of truth for qmd entrypoint path resolution.
//
// Both the real qmd caller (src/tools/search-all.ts) and the operator doctor
// (server/application/operator-doctor-probes.ts) MUST consume resolveQmdPath()
// so their view of the qmd binary location can never diverge. The default
// matches the documented prod layout on production-host.
//
// The configured path arrives as a parameter rather than being read here:
// `.oxlintrc.json` permits `process.env` only at the composition root. It is
// deliberately NOT `QmdConfigGroup` from `./env-groups.ts`: `qmdGroup` folds a
// blank `QMD_PATH` to absent, while this resolver branches on `=== undefined`
// and passes a blank value through as an empty path. Reusing that group would
// change what `QMD_PATH=""` resolves to. The zero-argument call form lives on
// in the `src/qmd-path.ts` L5 adapter.
export const DEFAULT_QMD_PATH = "/opt/qmd/src/qmd.ts";

export interface ResolvedQmdPath {
  path: string;
  source: "env" | "default";
}

/** The raw `QMD_PATH` reading, blank preserved and absent meaning unset. */
export interface QmdPathSettings {
  readonly qmdPath: string | undefined;
}

export function resolveQmdPath(settings: QmdPathSettings): ResolvedQmdPath {
  // Mirror the historical `process.env.QMD_PATH ?? DEFAULT_QMD_PATH` exactly
  // (no trimming) so search_all behavior is unchanged.
  if (settings.qmdPath === undefined) {
    return { path: DEFAULT_QMD_PATH, source: "default" };
  }
  return { path: settings.qmdPath, source: "env" };
}
