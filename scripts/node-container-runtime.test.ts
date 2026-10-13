import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const DOCKERFILE = join(ROOT, "Dockerfile");
const DEPLOYMENT = join(ROOT, "k8s/base/deployment.yaml");

function instructions(): string {
  return readFileSync(DOCKERFILE, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("Node container runtime", () => {
  it("pins both stages to Node 24 Alpine and installs the npm lockfile", () => {
    const source = instructions();
    const bases = [...source.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
    expect(bases).toEqual([
      "docker.io/library/node:24.13.1-alpine",
      "docker.io/library/node:24.13.1-alpine",
    ]);
    expect(source).toMatch(
      /^COPY package\.json package-lock\.json \.npmrc \.node-version \.\/\s*$/m,
    );
    expect(source).toMatch(/^RUN npm ci\s*$/m);
  });

  it("starts the TypeScript role entrypoint directly without an executable Bun instruction", () => {
    const source = instructions();
    // server/entry.ts picks server/main.ts or the NATS worker by OPEN_BRAIN_ROLE (issue 1594).
    expect(source).toMatch(/^ENTRYPOINT \["node", "server\/entry\.ts"\]\s*$/m);
    expect(source).not.toMatch(/^\s*(?:RUN|CMD|ENTRYPOINT)\b.*\bbun\b/im);
  });

  it("preserves Kaniko constraints, runtime identity, writable paths, and port", () => {
    const source = instructions();
    expect(source).toMatch(/^USER 5040:5040\s*$/m);
    expect(source).toMatch(/^EXPOSE 3100\s*$/m);
    expect(source).toContain("mkdir -p /var/lib/app/data /var/lib/app/scratch");
    expect(source).toContain("chown -R 5040:5040 /var/lib/app");
    expect(source).not.toMatch(/--mount=type=(?:cache|secret)|<<-?[A-Za-z_"']/);
  });

  it("runs the repository NATS worker with Node without weakening its pod boundary", () => {
    const source = readFileSync(DEPLOYMENT, "utf8");
    const worker = source.slice(source.indexOf("name: open-brain-nats-worker"));
    expect(worker).toContain('command: ["node", "scripts/run-nats-worker.ts"]');
    expect(worker).toContain("image: registry.example.internal/you/open-brain:v0.9.0");
    expect(worker).toContain("runAsNonRoot: true");
    expect(worker).toContain("OPEN_BRAIN_RUN_MIGRATIONS");
    expect(worker).toMatch(/OPEN_BRAIN_RUN_MIGRATIONS\s*\n\s*value: "0"/);
  });
});
