import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";

function decoratorPreset(options: Record<string, unknown>) {
  return {
    preset: () => ({
      plugins: [["@babel/plugin-proposal-decorators", options]],
    }),
    rolldown: {
      // Only these fixtures exercise native decorator syntax. The id filter
      // prevents scoped imports and comments elsewhere from selecting Babel.
      filter: {
        id: /\/server\/logging\/decorate(?:\.driver)?\.test\.ts(?:\?.*)?$/,
        code: "@",
      },
    },
  };
}

export default defineConfig({
  plugins: [babel({ presets: [decoratorPreset({ version: "2023-11" })] })],
  test: {
    include: [
      "server/**/*.test.ts",
      "scripts/**/*.test.ts",
      "eval/**/*.test.ts",
      "clients/ts/tests/**/*.test.ts",
      "tests/**/*.test.ts",
      ".codex/**/*.test.ts",
    ],
    // One isolated database is shared by the full run; files must not mutate it
    // concurrently. Per-file process isolation still protects module mocks.
    fileParallelism: false,
    isolate: true,
    clearMocks: false,
    // CI runner tail (issue 1518): on 2026-09-25 untouched files crossed the
    // 5000 ms test and 10000 ms hook defaults (dream-light-producer 15010 ms,
    // a reviewed-candidate-promotion hook 16603 ms; ob-backfill scans measured
    // 5152-7637 ms earlier). Locally the same files run in hundreds of ms.
    // 30 s absorbs the runner tail once, globally; a real hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
