import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_MATRIX_PATH, loadMatrix } from "./matrix.ts";
import { DESTINATIONS } from "./types.ts";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

describe("loadMatrix", () => {
  it("reads five rows from the committed matrix", () => {
    const matrix = loadMatrix(DEFAULT_MATRIX_PATH);
    expect(matrix.rows).toHaveLength(5);
    expect(matrix.rows.map((row) => row.name)).toEqual([...DESTINATIONS]);
    expect(matrix.rows.filter((row) => row.commits)).toHaveLength(4);
    expect(matrix.rows.find((row) => row.name === "steering")?.commits).toBe(false);
  });

  it("fingerprints the file bytes as 12 hex characters", () => {
    const first = loadMatrix(DEFAULT_MATRIX_PATH).fingerprint;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(loadMatrix(fixture("good.tsv")).fingerprint).not.toBe(first);
  });

  it("skips the comment header and blank lines", () => {
    expect(loadMatrix(fixture("good.tsv")).rows[0]).toEqual({
      name: "rule",
      line: "a standing rule about how work is done",
      commits: true,
    });
  });

  it("throws naming path:line when a row is not three cells", () => {
    expect(() => loadMatrix(fixture("two-cells.tsv"))).toThrow(
      /two-cells\.tsv:2: expected exactly three/,
    );
  });

  it("throws on an unknown destination name", () => {
    expect(() => loadMatrix(fixture("bad-name.tsv"))).toThrow(
      /bad-name\.tsv:2: unknown destination "banana"/,
    );
  });

  it("throws on a description outside 10 to 300 characters", () => {
    expect(() => loadMatrix(fixture("short-line.tsv"))).toThrow(
      /short-line\.tsv:2: description must be 10 to 300 characters/,
    );
  });

  it("throws when commits is not exactly true or false", () => {
    expect(() => loadMatrix(fixture("bad-commits.tsv"))).toThrow(
      /bad-commits\.tsv:2: commits must be "true" or "false"/,
    );
  });

  it("throws naming a missing destination", () => {
    expect(() => loadMatrix(fixture("missing-destination.tsv"))).toThrow(
      /destination decision is missing/,
    );
  });

  it("throws naming a repeated destination", () => {
    expect(() => loadMatrix(fixture("repeated-destination.tsv"))).toThrow(
      /destination rule appears 2 times/,
    );
  });
});
