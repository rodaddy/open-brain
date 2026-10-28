/**
 * The shape every `server/` boundary barrel exports to declare what it owns.
 * Read by `server/index.ts` and the contract tests to check the declared module
 * map against what is actually wired.
 */
export interface ServerModuleBoundary {
  name: string;
  owns: readonly string[];
  excludes: readonly string[];
}
