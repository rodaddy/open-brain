import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DUMP_FILENAME,
  MANIFEST_FILENAME,
  buildManifest,
  sha256File,
  type BackupDbInfo,
  type BackupManifestV1,
  type CurrentRuntime,
} from "../backup-lib.ts";

/** Runtime the backup fixtures are built against. */
export const RUNTIME: CurrentRuntime = {
  repoMigrations: ["001_init.sql", "002_curation.sql", "003_extras.sql"],
  contractVersion: "2026-07-17.memory-tools.v22",
  embeddingModel: "test-embedding-model",
  embeddingDimensions: 768,
};

export const NS_SENTINEL = "SENTINEL-NAMESPACE-ALPHA";
export const CONTENT_SENTINEL = "SENTINEL-ROW-CONTENT-DO-NOT-LEAK";
export const PASSWORD_SENTINEL = ["SENTINEL-DB", "PASSWORD-123"].join("-");

const tempDirs: string[] = [];

/** Creates a scratch directory registered for removal by `cleanupTempDirs`. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ob298-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Removes every directory handed out by `tempDir`. */
export async function cleanupTempDirs(): Promise<void> {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
}

export function makeDbInfo(overrides: Partial<BackupDbInfo> = {}): BackupDbInfo {
  return {
    appliedMigrations: [...RUNTIME.repoMigrations],
    pgvectorVersion: "0.8.2",
    rowCounts: { _migrations: 3, thoughts: 5, ob_session_lanes: 1 },
    archivedRowCounts: { thoughts: 1 },
    distinctNamespaces: 2,
    ...overrides,
  };
}

/** A manifest as loose JSON, so tests can corrupt fields the schema forbids. */
export type MutableManifest = Record<string, unknown>;

export interface SetOverrides {
  dbInfo?: Partial<BackupDbInfo>;
  contractVersion?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  createdAt?: string;
  dumpBytes?: Uint8Array;
  mutateManifest?: (m: MutableManifest) => MutableManifest;
}

/** Write a structurally valid backup set into `dir` and return its manifest. */
export async function writeSet(
  dir: string,
  overrides: SetOverrides = {},
): Promise<BackupManifestV1> {
  await mkdir(dir, { recursive: true });
  const dumpBytes =
    overrides.dumpBytes ??
    new TextEncoder().encode("fake-pg-dump-bytes-for-unit-tests");
  const dumpPath = join(dir, DUMP_FILENAME);
  await writeFile(dumpPath, dumpBytes);
  const { sha256, bytes } = await sha256File(dumpPath);
  const manifest = buildManifest({
    dbInfo: makeDbInfo(overrides.dbInfo),
    source: { db_host: "127.0.0.1", db_port: 5432, db_name: "unit_db" },
    contract: {
      version: overrides.contractVersion ?? RUNTIME.contractVersion,
      schema_hash: "a".repeat(64),
    },
    embedding: {
      model: overrides.embeddingModel ?? RUNTIME.embeddingModel,
      dimensions: overrides.embeddingDimensions ?? RUNTIME.embeddingDimensions,
    },
    files: [{ name: DUMP_FILENAME, sha256, bytes }],
    createdAt: overrides.createdAt,
    hostname: "unit-host",
  });
  const written = overrides.mutateManifest
    ? overrides.mutateManifest(structuredClone(manifest) as unknown as MutableManifest)
    : manifest;
  await writeFile(join(dir, MANIFEST_FILENAME), JSON.stringify(written));
  return manifest;
}

export function verdictFor(
  result: {
    verdicts: Array<{ element: string; verdict: string; reason: string }>;
  },
  element: string,
): Array<{ verdict: string; reason: string }> {
  return result.verdicts
    .filter((v) => v.element === element)
    .map(({ verdict, reason }) => ({ verdict, reason }));
}
