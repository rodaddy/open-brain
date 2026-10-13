import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { testScratchDir } from "../../scripts/test-support/scratch-dir.ts";

let scratchDir = "";

afterEach(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = "";
});

function createIndex(): string {
  scratchDir = testScratchDir("operator-doctor-worker-");
  const indexPath = join(scratchDir, "index.sqlite");
  const database = new DatabaseSync(indexPath);
  database.exec(`
    CREATE TABLE documents (active INTEGER NOT NULL);
    CREATE TABLE store_collections (name TEXT NOT NULL);
    INSERT INTO documents VALUES (1), (1), (0);
    INSERT INTO store_collections VALUES ('one'), ('two'), ('three');
  `);
  database.close();
  return indexPath;
}

function runProbe(inputTypeArgs: string[], indexPath: string) {
  const moduleUrl = pathToFileURL(
    join(import.meta.dirname, "operator-doctor-probes.ts"),
  ).href;
  const script = `
    import { checkQmdStatus } from ${JSON.stringify(moduleUrl)};
    const result = await checkQmdStatus({
      qmdPath: process.execPath,
      qmdIndexPath: ${JSON.stringify(indexPath)},
      qmdIndexPathSource: "option",
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(
    process.execPath,
    [...inputTypeArgs, "--no-warnings", "--eval", script],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(child.signal, child.stderr).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as {
    status: string;
    index: { status: string; document_count: number; collection_count: number };
  };
}

describe("checkQmdStatus worker argv", () => {
  it.each([
    ["equals spelling", ["--input-type=module"]],
    ["separated spelling", ["--input-type", "module"]],
  ])("reads the real index with %s", (_label, inputTypeArgs) => {
    const result = runProbe(inputTypeArgs, createIndex());
    expect(result.status).toBe("available");
    expect(result.index).toMatchObject({
      status: "available",
      document_count: 2,
      collection_count: 3,
    });
  });

  it("returns the unavailable fallback for a missing index", () => {
    scratchDir = testScratchDir("operator-doctor-worker-missing-");
    const result = runProbe(
      ["--input-type", "module"],
      join(scratchDir, "missing.sqlite"),
    );
    expect(result.status).toBe("available");
    expect(result.index.status).toBe("unavailable");
  });
});
