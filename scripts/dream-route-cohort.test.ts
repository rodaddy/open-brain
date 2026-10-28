import { expect, test } from "vitest";
import {
  mergeByPrecedence,
  parseDreamRouteArgs,
  stratumShare,
  teardownCommand,
  type CohortMember,
} from "./dream-route-cohort.ts";

const namespace = "dream-route-unit";

test("defaults every optional argument", () => {
  expect(parseDreamRouteArgs(["--namespace", namespace])).toEqual({
    namespace,
    fraction: 0.05,
    seed: "dream-route-v1",
    neighbours: 3,
    neighboursFor: "decided",
    maxDistance: 0.15,
    labels: undefined,
    note: "",
    allowLiveDb: false,
  });
});

test("takes either --neighbours-for value and refuses any other", () => {
  for (const mode of ["decided", "all"] as const) {
    expect(
      parseDreamRouteArgs(["--namespace", namespace, "--neighbours-for", mode])
        .neighboursFor,
    ).toBe(mode);
  }
  for (const bad of ["typed", "none", "ALL", ""]) {
    expect(() =>
      parseDreamRouteArgs(["--namespace", namespace, "--neighbours-for", bad]),
    ).toThrow(/--neighbours-for must be one of decided, all/);
  }
});

test("accepts every argument at once", () => {
  expect(
    parseDreamRouteArgs([
      "--namespace",
      namespace,
      "--fraction",
      "0.5",
      "--seed",
      "other-seed",
      "--neighbours",
      "7",
      "--neighbours-for",
      "all",
      "--max-distance",
      "0.3",
      "--labels",
      "dream_run_004",
      "--note",
      "a note",
      "--allow-live-db",
    ]),
  ).toEqual({
    namespace,
    fraction: 0.5,
    seed: "other-seed",
    neighbours: 7,
    neighboursFor: "all",
    maxDistance: 0.3,
    labels: "dream_run_004",
    note: "a note",
    allowLiveDb: true,
  });
});

test("throws on an unknown -- token", () => {
  expect(() => parseDreamRouteArgs(["--namespace", namespace, "--nope"])).toThrow(
    /unknown option: --nope/,
  );
});

test("requires a namespace and refuses a padded one", () => {
  expect(() => parseDreamRouteArgs([])).toThrow(/--namespace is required/);
  expect(() => parseDreamRouteArgs(["--namespace", " padded "])).toThrow(
    /surrounding whitespace/,
  );
});

test("refuses a fraction outside (0, 1]", () => {
  for (const bad of ["0", "-0.1", "1.5", "abc"]) {
    expect(() =>
      parseDreamRouteArgs(["--namespace", namespace, "--fraction", bad]),
    ).toThrow(/--fraction/);
  }
  expect(
    parseDreamRouteArgs(["--namespace", namespace, "--fraction", "1"]).fraction,
  ).toBe(1);
});

test("refuses non-integer or negative neighbours", () => {
  for (const bad of ["-1", "1.5", "abc"]) {
    expect(() =>
      parseDreamRouteArgs(["--namespace", namespace, "--neighbours", bad]),
    ).toThrow(/--neighbours/);
  }
  expect(
    parseDreamRouteArgs(["--namespace", namespace, "--neighbours", "0"]).neighbours,
  ).toBe(0);
});

test("refuses a max distance outside [0, 2]", () => {
  for (const bad of ["-0.1", "2.5", "abc"]) {
    expect(() =>
      parseDreamRouteArgs(["--namespace", namespace, "--max-distance", bad]),
    ).toThrow(/--max-distance/);
  }
});

test("refuses a labels schema that is not dream_run_NNN", () => {
  for (const bad of ["dream_run_1", "public", "dream_run_0004", "dream_run_abc"]) {
    expect(() =>
      parseDreamRouteArgs(["--namespace", namespace, "--labels", bad]),
    ).toThrow(/--labels must name a dream_run_NNN schema/);
  }
});

test("refuses an empty seed and a repeated or valueless option", () => {
  expect(() => parseDreamRouteArgs(["--namespace", namespace, "--seed", ""])).toThrow(
    /--seed must be non-empty/,
  );
  expect(() =>
    parseDreamRouteArgs(["--namespace", namespace, "--seed", "a", "--seed", "b"]),
  ).toThrow(/--seed may be supplied only once/);
  expect(() => parseDreamRouteArgs(["--namespace", namespace, "--note"])).toThrow(
    /--note requires a value/,
  );
});

test("stratum share is ceil(fraction * count), bounded by the stratum", () => {
  expect(stratumShare(0, 0.05)).toBe(0);
  expect(stratumShare(0, 1)).toBe(0);
  expect(stratumShare(1, 0.05)).toBe(1);
  expect(stratumShare(20, 0.05)).toBe(1);
  expect(stratumShare(21, 0.05)).toBe(2);
  expect(stratumShare(40, 0.05)).toBe(2);
  expect(stratumShare(41, 0.05)).toBe(3);
  expect(stratumShare(7, 1)).toBe(7);
  expect(stratumShare(7, 0.5)).toBe(4);
  expect(() => stratumShare(-1, 0.5)).toThrow(/non-negative integer/);
  expect(() => stratumShare(1.5, 0.5)).toThrow(/non-negative integer/);
});

test("precedence keeps labelled over draw over neighbour, once each", () => {
  const members: CohortMember[] = [
    { candidateId: "b", source: "neighbour", neighbourOf: "a" },
    { candidateId: "b", source: "draw", neighbourOf: null },
    { candidateId: "c", source: "draw", neighbourOf: null },
    { candidateId: "c", source: "labelled", neighbourOf: null },
    { candidateId: "d", source: "neighbour", neighbourOf: "a" },
    { candidateId: "a", source: "draw", neighbourOf: null },
  ];
  expect(mergeByPrecedence(members)).toEqual([
    { candidateId: "c", source: "labelled", neighbourOf: null },
    { candidateId: "a", source: "draw", neighbourOf: null },
    { candidateId: "b", source: "draw", neighbourOf: null },
    { candidateId: "d", source: "neighbour", neighbourOf: "a" },
  ]);
});

test("precedence is order-independent and drops neighbour_of on promotion", () => {
  const reversed: CohortMember[] = [
    { candidateId: "b", source: "draw", neighbourOf: null },
    { candidateId: "b", source: "neighbour", neighbourOf: "a" },
  ];
  expect(mergeByPrecedence(reversed)).toEqual([
    { candidateId: "b", source: "draw", neighbourOf: null },
  ]);
  expect(mergeByPrecedence([])).toEqual([]);
});

test("teardown names the existing --drop path and guards the schema", () => {
  expect(teardownCommand("dream_run_007")).toBe(
    "node --env-file=.env scripts/rem-ethereal-run.ts --drop dream_run_007",
  );
  expect(() => teardownCommand("public")).toThrow(/invalid dream run schema/);
});
