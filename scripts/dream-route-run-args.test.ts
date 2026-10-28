import { expect, test } from "vitest";
import { parseRunArgs } from "./dream-route-run.ts";

test("--allow-live-db defaults off", () => {
  expect(parseRunArgs(["--schema", "dream_run_001"]).allowLiveDb).toBe(false);
});

test("--allow-live-db is accepted and sets allowLiveDb", () => {
  expect(
    parseRunArgs(["--schema", "dream_run_001", "--allow-live-db"]).allowLiveDb,
  ).toBe(true);
});

test("an unknown option is still refused", () => {
  expect(() => parseRunArgs(["--schema", "dream_run_001", "--allow-live"])).toThrow(
    "unknown option: --allow-live",
  );
});
