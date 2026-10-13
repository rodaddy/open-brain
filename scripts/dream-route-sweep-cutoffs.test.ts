import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import type { JevAnswer } from "../server/integrations/jev.ts";
import {
  DEFAULT_MATRIX_PATH,
  loadMatrix,
} from "../server/domain/dream-route/matrix.ts";
import { sweepCutoffs, type SweepReading } from "./dream-route-sweep-cutoffs.ts";
import { testScratchBase } from "./test-support/scratch-dir.ts";

const scratch = `${testScratchBase()}/dream-route-sweep`;
const script = fileURLToPath(
  new URL("./dream-route-sweep-cutoffs.ts", import.meta.url),
);

const ROWS = ["rule", "decision", "fact", "correction", "steering", "none"] as const;

function dest(choice: string, pWin: number, confidence: number): JevAnswer {
  const rest = (1 - pWin) / (ROWS.length - 1);
  const probabilities = Object.fromEntries(
    ROWS.map((row) => [row, row === choice ? pWin : rest]),
  );
  return { type: "choice", choice, probabilities, confidence } as JevAnswer;
}

function reading(
  id: string,
  golden: string,
  lasting: number,
  destination: JevAnswer,
): SweepReading {
  return {
    candidate_id: id,
    golden_dest: golden,
    singleton_answers: {
      anything_lasting: { type: "noul", noul: lasting } as JevAnswer,
      destination,
      drove_decision: { type: "noul", noul: 0.2 } as JevAnswer,
    },
  };
}

const READINGS: SweepReading[] = [
  reading("clear-rule", "rule", 0.9, dest("rule", 0.9, 0.9)),
  reading("clear-none", "none", 0.1, dest("none", 0.9, 0.9)),
  reading("weak-rule", "none", 0.8, dest("rule", 0.4, 0.8)),
  reading("weak-fact", "fact", 0.3, dest("fact", 0.8, 0.8)),
];

describe("sweepCutoffs", () => {
  test("finds cutoffs that commit nothing false and match every golden", () => {
    const result = sweepCutoffs(READINGS, loadMatrix(DEFAULT_MATRIX_PATH));
    expect(result.cases).toBe(4);
    expect(result.best.false_commit).toBe(0);
    expect(
      result.best.golden,
      "4: lastingAt<=0.3 admits the weak fact while pickAt>0.4 blocks the weak rule",
    ).toBe(4);
    const total = Object.values(result.confusion)
      .flatMap((row) => Object.values(row))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
    expect(result.top.length).toBeLessThanOrEqual(10);
  });

  test("CLI writes the sweep json and prints BEST", () => {
    mkdirSync(scratch, { recursive: true });
    const path = `${scratch}/synthetic.readings.json`;
    writeFileSync(path, JSON.stringify(READINGS));
    const run = spawnSync(process.execPath, [script, "--readings", path, "--json"], {
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("BEST ");
    expect(existsSync(`${scratch}/synthetic.sweep.json`)).toBe(true);
  });
});
