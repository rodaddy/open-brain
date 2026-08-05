import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const setupClientPath = join(repoRoot, "scripts/setup-client.sh");
const setupClient = readFileSync(setupClientPath, "utf8");
const blockStart = "# --- begin hook env-file path normalization ---";
const blockEnd = "# --- end hook env-file path normalization ---";
const heredocStart = `python3 - "$TARGET_ENV_DIR/openbrain-hook-env" <<'PY'\n`;

function extractNormalizer(): string {
  const start = setupClient.indexOf(blockStart);
  const end = setupClient.indexOf(blockEnd, start);
  if (start < 0 || end < 0) {
    throw new Error("setup-client hook env-file normalization markers missing");
  }

  const managedBlock = setupClient.slice(start, end);
  const pythonStart = managedBlock.indexOf(heredocStart);
  const pythonEnd = managedBlock.indexOf("\nPY\n", pythonStart);
  if (pythonStart < 0 || pythonEnd < 0) {
    throw new Error("setup-client hook env-file Python heredoc missing");
  }

  return managedBlock.slice(pythonStart + heredocStart.length, pythonEnd);
}

const scratchRoot = join(repoRoot, "out", "test-fixtures");
mkdirSync(scratchRoot, { recursive: true });
const suiteRoot = mkdtempSync(join(scratchRoot, "setup-client-hook-env-"));
process.stderr.write(`setup-client-hook-env fixtures: ${suiteRoot}\n`);
const normalizerPath = join(suiteRoot, "normalize-hook-env.py");
writeFileSync(normalizerPath, extractNormalizer());

const authorEnvFile =
  "/Users/rico/.local/share/openbrain-memory/env/claudex-observation.env";
const managedBegin = "# >>> openbrain: hook env file (managed) >>>";

function legacyWrapper(envFile = authorEnvFile): string {
  return `#!/bin/sh
set -eu

ENV_FILE="${envFile}"

PARENT_OPENBRAIN_TOKEN="\${OPENBRAIN_TOKEN:-}"
PARENT_OPENBRAIN_BASE_URL="\${OPENBRAIN_BASE_URL:-}"

set -a
. "$ENV_FILE"
set +a

OPENBRAIN_TOKEN="\${PARENT_OPENBRAIN_TOKEN:-\${OPENBRAIN_TOKEN:-}}"
OPENBRAIN_BASE_URL="\${PARENT_OPENBRAIN_BASE_URL:-\${OPENBRAIN_BASE_URL:-}}"

exec env -i \\
  PATH="$PATH" \\
  HOME="$HOME" \\
  OPENBRAIN_BASE_URL="\${OPENBRAIN_BASE_URL:-}" \\
  OPENBRAIN_TOKEN="\${OPENBRAIN_TOKEN:-}" \\
  "$@"
`;
}

function createWrapper(directory: string, source = legacyWrapper()): string {
  mkdirSync(directory, { recursive: true });
  const wrapperPath = join(directory, "openbrain-hook-env");
  writeFileSync(wrapperPath, source);
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function normalize(wrapperPath: string) {
  return spawnSync("python3", [normalizerPath, wrapperPath], {
    encoding: "utf8",
  });
}

function runWrapper(wrapperPath: string, home: string) {
  return spawnSync(wrapperPath, ["/usr/bin/env"], {
    encoding: "utf8",
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
}

function sourceWrapper(shell: string, wrapperPath: string, home: string) {
  return spawnSync(
    shell,
    [
      "-c",
      'wrapper=$1; set -- /usr/bin/env; . "$wrapper"',
      join(suiteRoot, "wrong-invocation-path/openbrain-hook-env"),
      wrapperPath,
    ],
    {
      encoding: "utf8",
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  );
}

function fixtureDirectory(name: string): string {
  return mkdtempSync(join(suiteRoot, `${name}-`));
}

describe("setup-client hook env-file normalization", () => {
  it("removes the build machine's hardcoded absolute path", () => {
    const wrapperPath = createWrapper(fixtureDirectory("legacy"));

    const result = normalize(wrapperPath);

    expect(result.status).toBe(0);
    const normalized = readFileSync(wrapperPath, "utf8");
    expect(normalized).not.toContain(authorEnvFile);
    expect(normalized).toContain(managedBegin);
  });

  it("derives the sibling env file under a non-author HOME", () => {
    const home = fixtureDirectory("cc-user-home");
    const envDirectory = join(
      home,
      ".local/share/openbrain-memory/env",
    );
    const wrapperPath = createWrapper(envDirectory);
    writeFileSync(
      join(envDirectory, "claudex-observation.env"),
      "OPENBRAIN_BASE_URL=http://example.invalid\n" +
        "OPENBRAIN_TOKEN=ob-test-placeholder\n",
    );
    expect(normalize(wrapperPath).status).toBe(0);

    const result = runWrapper(wrapperPath, home);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "OPENBRAIN_BASE_URL=http://example.invalid\n",
    );
    expect(result.stdout).toContain("OPENBRAIN_TOKEN=ob-test-placeholder\n");
    expect(result.stderr).toBe("");
  });

  it("resolves a PATH-invoked symlink to the wrapper's real directory", () => {
    const home = fixtureDirectory("symlink-home");
    const root = fixtureDirectory("symlink-layout");
    const envDirectory = join(root, "env");
    const binDirectory = join(root, "bin");
    const wrapperPath = createWrapper(envDirectory);
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(
      join(envDirectory, "claudex-observation.env"),
      "OPENBRAIN_BASE_URL=http://symlink.invalid\n" +
        "OPENBRAIN_TOKEN=ob-symlink-placeholder\n",
    );
    expect(normalize(wrapperPath).status).toBe(0);
    symlinkSync(
      "../env/openbrain-hook-env",
      join(binDirectory, "openbrain-hook-env"),
    );

    const result = spawnSync("openbrain-hook-env", ["/usr/bin/env"], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${binDirectory}:/usr/bin:/bin` },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "OPENBRAIN_BASE_URL=http://symlink.invalid\n",
    );
    expect(result.stderr).toBe("");
  });

  it("uses the sourced wrapper location in bash and zsh", () => {
    const home = fixtureDirectory("sourced-home");
    const envDirectory = fixtureDirectory("sourced-wrapper");
    const wrapperPath = createWrapper(envDirectory);
    writeFileSync(
      join(envDirectory, "claudex-observation.env"),
      "OPENBRAIN_BASE_URL=http://sourced.invalid\n" +
        "OPENBRAIN_TOKEN=ob-sourced-placeholder\n",
    );
    expect(normalize(wrapperPath).status).toBe(0);

    for (const shell of ["bash", "zsh"]) {
      const result = sourceWrapper(shell, wrapperPath, home);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "OPENBRAIN_BASE_URL=http://sourced.invalid\n",
      );
      expect(result.stderr).toBe("");
    }
  });

  it("fails loudly when the wrapper directory cannot be resolved", () => {
    const home = fixtureDirectory("fallback-home");
    const fallbackDirectory = join(
      home,
      ".local/share/openbrain-memory/env",
    );
    mkdirSync(fallbackDirectory, { recursive: true });
    writeFileSync(
      join(fallbackDirectory, "claudex-observation.env"),
      "OPENBRAIN_BASE_URL=http://fallback.invalid\n" +
        "OPENBRAIN_TOKEN=ob-fallback-placeholder\n",
    );
    const wrapperPath = createWrapper(fixtureDirectory("fallback-wrapper"));
    expect(normalize(wrapperPath).status).toBe(0);
    const missingWrapperPath = join(
      suiteRoot,
      "missing-directory/openbrain-hook-env",
    );

    const result = spawnSync(
      "/bin/dash",
      [
        "-c",
        'wrapper=$1; set -- /usr/bin/env; . "$wrapper"',
        missingWrapperPath,
        wrapperPath,
      ],
      {
        encoding: "utf8",
        env: { HOME: home, PATH: "/usr/bin:/bin" },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("could not resolve wrapper directory");
    expect(result.stderr).toContain(missingWrapperPath);
  });

  it("converges to one managed block when run twice", () => {
    const home = fixtureDirectory("idempotent-home");
    const envDirectory = join(
      home,
      ".local/share/openbrain-memory/env",
    );
    const wrapperPath = createWrapper(envDirectory);
    writeFileSync(
      join(envDirectory, "claudex-observation.env"),
      "OPENBRAIN_BASE_URL=http://idempotent.invalid\n" +
        "OPENBRAIN_TOKEN=ob-idempotent-placeholder\n",
    );

    expect(normalize(wrapperPath).status).toBe(0);
    expect(normalize(wrapperPath).status).toBe(0);

    const normalized = readFileSync(wrapperPath, "utf8");
    expect(normalized.split(managedBegin)).toHaveLength(2);
    const result = runWrapper(wrapperPath, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "OPENBRAIN_TOKEN=ob-idempotent-placeholder\n",
    );
  });

  it("fails loudly with no stdout when the derived env file is missing", () => {
    const home = fixtureDirectory("missing-home");
    const envDirectory = join(
      home,
      ".local/share/openbrain-memory/env",
    );
    const wrapperPath = createWrapper(envDirectory);
    expect(normalize(wrapperPath).status).toBe(0);

    const result = runWrapper(wrapperPath, home);
    const expectedPath = join(envDirectory, "claudex-observation.env");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(expectedPath);
    expect(result.stderr).toContain("wrapper source:");
    expect(result.stderr).toContain("missing or unreadable");
  });

  it("refuses a wrapper shape with no recognized insertion point", () => {
    const wrapperPath = createWrapper(
      fixtureDirectory("unknown"),
      "#!/bin/sh\nset -eu\nexec env -i \"$@\"\n",
    );

    const result = normalize(wrapperPath);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("neither a legacy ENV_FILE assignment");
    expect(result.stderr).toContain("managed hook env-file block");
    expect(result.stderr).toContain("Refusing to guess an insertion point");
  });
});
