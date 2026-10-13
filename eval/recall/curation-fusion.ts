import { DEFAULT_FTS_CONFIG } from "../../server/tools/fts-config.ts";
import { hybridSearch } from "../../server/tools/search-engine.ts";
import type {
  SearchDependencies,
  SearchRow,
  SearchSource,
} from "../../server/tools/search-engine-types.ts";
import { fuseLocally, toRankedRow, type RankedRow } from "./fusion.ts";

interface HybridFixture {
  readonly id: string;
  readonly query: string;
  readonly namespace: string;
}

interface HybridCandidateRows {
  readonly vectorRows: readonly RankedRow[];
  readonly ftsRows: readonly RankedRow[];
  readonly fusedRows: readonly RankedRow[];
}

interface CurationFusionOptions {
  readonly sources: readonly SearchSource[];
  readonly limit: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch the exact candidate arms and fused output of one hybrid retrieval. */
export async function runHybridCandidateArms(
  dependencies: SearchDependencies,
  fixture: HybridFixture,
  options: CurationFusionOptions,
): Promise<HybridCandidateRows> {
  const { sources, limit, maxAttempts, retryDelayMs } = options;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const embedding = await dependencies.embedFn(fixture.query);
      if (!embedding) throw new Error("Failed to generate query embedding");
      let arms: { vectorRows: SearchRow[]; ftsRows: SearchRow[] } | undefined;
      const fusedRows = await hybridSearch(
        dependencies,
        {
          tables: sources,
          query: fixture.query,
          limit,
          mode: "hybrid",
          tier: undefined,
          offset: 0,
          namespace: fixture.namespace,
          ftsConfig: DEFAULT_FTS_CONFIG,
        },
        embedding,
        (value) => {
          arms = value;
        },
      );
      if (!arms) throw new Error("Hybrid candidate arms were not observed");
      const ranked = (rows: readonly SearchRow[]): readonly RankedRow[] =>
        rows.map(toRankedRow);
      return {
        vectorRows: ranked(arms.vectorRows),
        ftsRows: ranked(arms.ftsRows),
        fusedRows: ranked(fusedRows),
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Failed to generate query embedding" ||
        attempt === maxAttempts
      ) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }
  throw new Error(
    `embedding_unavailable: ${fixture.id} could not be embedded in ${String(maxAttempts)} attempts`,
  );
}

/** Assert independent fusion agrees with the engine result from those arms. */
export async function verifyLocalFusionMatchesEngine(
  dependencies: SearchDependencies,
  fixture: HybridFixture,
  options: CurationFusionOptions,
): Promise<void> {
  const { limit } = options;
  const { vectorRows, ftsRows, fusedRows } = await runHybridCandidateArms(
    dependencies,
    fixture,
    options,
  );
  const local = fuseLocally(vectorRows, ftsRows, limit, false);
  const engine = fusedRows.map((row) => row.key);
  if (local.join(",") !== engine.join(",")) {
    throw new Error(
      `local_fusion_diverged: ${fixture.id}\n  engine: ${engine.join(", ")}\n  local:  ${local.join(", ")}`,
    );
  }
}
