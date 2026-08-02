export interface ServerModuleBoundary {
  name: string;
  owns: readonly string[];
  excludes: readonly string[];
}
