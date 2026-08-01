/**
 * Reference implementation of the Development TypeScript standard.
 *
 * Not a library to depend on -- a worked example of every rule in
 * `_DOCS/STANDARDS-typescript.md`, written so the rules can be read as code and,
 * more importantly, so the enforcement can be OBSERVED rejecting a violation
 * rather than merely described.
 *
 * Layout:
 * - `config.ts` -- the keystone. Sources, precedence, validation at boot.
 * - `models/` -- Zod schemas only, no behaviour.
 * - `utils/` -- the shared floor: time, http, logging.
 * - `db/` -- typed SQL over `node:sqlite`, for history.
 * - `apps/` -- four runnable surfaces: monitor, watch, hook, stats.
 *
 * The enforcement lives in `eslint.config.js`, `tsconfig.json`, `_githooks/`,
 * and `.github/workflows/ci.yml`, all running the same checks so none can drift.
 * `scripts/dev/demo-hooks.sh` proves each hook still blocks what it claims to.
 *
 * @see _DOCS/STANDARDS-typescript.md -- the standard this implements
 * @see _DOCS/python-exemplar/ -- the same standard, in Python
 */

export { loadSettings, PROJECT_ROOT } from "./config.ts";
export type { Settings } from "./config.ts";
