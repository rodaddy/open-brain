// L5 adapter (issue 864): legacy call form over server/config/qmd-path.ts; retired with src/ at L6.
import {
  resolveQmdPath as resolveQmdPathWithSettings,
  type ResolvedQmdPath,
} from "../server/config/qmd-path.ts";

export { DEFAULT_QMD_PATH } from "../server/config/qmd-path.ts";
export type { ResolvedQmdPath } from "../server/config/qmd-path.ts";

/** The legacy form: an optional env record, defaulted to `process.env`. */
export function resolveQmdPath(
  env: Record<string, string | undefined> = process.env,
): ResolvedQmdPath {
  return resolveQmdPathWithSettings({ qmdPath: env.QMD_PATH });
}
