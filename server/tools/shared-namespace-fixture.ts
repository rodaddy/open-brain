/**
 * The default shared-namespace name set, for tests that wire tool dependencies.
 *
 * `server/tools/shared-namespace.ts` reads no environment: every name arrives
 * from `ServerConfig.sharedNamespaceNames`, and a call site that omits it
 * throws. A test that registers the memory tools therefore has to supply the
 * set the same way `server/main.ts` does. This is the set an unconfigured
 * deployment produces, so a test using it asserts against the same names it
 * always did — the values are unchanged, only their source is.
 */
import type { SharedNamespaceGroup } from "../config/env-groups.ts";

/** The name set an operator who has configured nothing gets. */
export const DEFAULT_SHARED_NAMESPACE_NAMES: SharedNamespaceGroup = {
  canonicalSharedNamespace: "shared-kb",
  physicalSharedNamespace: "shared-kb",
  legacySharedNamespace: "",
  legacyFallbackEnabled: false,
  fallbackMinResults: 5,
};
