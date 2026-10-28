import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { testScratchDir } from "./test-support/scratch-dir.ts";

const ROOT = join(import.meta.dirname, "..");
let scratch = "";

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

describe("Node package runtime", () => {
  it("pins Node 24, npm, and explicit Node types without Bun artifacts", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=24 <25");
    expect(pkg.devDependencies["@types/node"]).toBe("^24.0.0");
    expect(pkg.devDependencies["@types/bun"]).toBeUndefined();
    expect(tsconfig.compilerOptions).toMatchObject({
      types: ["node"],
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
    });
    expect(readFileSync(join(ROOT, ".node-version"), "utf8").trim()).toBe("24");
    expect(readFileSync(join(ROOT, ".npmrc"), "utf8")).toContain("engine-strict=true");
    expect(existsSync(join(ROOT, "bun.lock"))).toBe(false);
    expect(existsSync(join(ROOT, "bunfig.toml"))).toBe(false);
  });

  it("keeps operational scripts native and preserves test isolation", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    expect(
      Object.values(scripts).some((command) => /\bbun(?:x)?\b/.test(command)),
    ).toBe(false);
    expect(scripts.test).toBe("node node_modules/vitest/vitest.mjs run");
    expect(scripts["test:isolated"]).toBe("node scripts/test-isolated.ts");
    expect(scripts.migrate).toBe("node --env-file-if-exists=.env scripts/migrate.ts");
    expect(scripts.db).toBe("node --env-file=.env scripts/db.ts");
    expect(scripts["sample:grade"]).toBe(
      "node --env-file=.env scripts/grading-sample.ts",
    );
  });

  it("loads optional dotenv values without overriding exported values", () => {
    scratch = testScratchDir("node-package-env-");
    writeFileSync(join(scratch, ".env"), "PACKAGE_RUNTIME_PROBE=from-file\n");
    const script = "process.stdout.write(process.env.PACKAGE_RUNTIME_PROBE ?? '')";
    const fromFile = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "--eval", script],
      { cwd: scratch, encoding: "utf8", env: {} },
    );
    expect(fromFile.status, fromFile.stderr).toBe(0);
    expect(fromFile.stdout).toBe("from-file");
    const exported = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "--eval", script],
      {
        cwd: scratch,
        encoding: "utf8",
        env: { PACKAGE_RUNTIME_PROBE: "exported-wins" },
      },
    );
    expect(exported.status, exported.stderr).toBe(0);
    expect(exported.stdout).toBe("exported-wins");
  });

  it("keeps package-lock root dependency identity aligned with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]?.dependencies).toEqual(pkg.dependencies);
    expect(lock.packages[""]?.devDependencies).toEqual(pkg.devDependencies);
  });
});
