import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Pool } from "pg";
import { createBrainServer } from "../src/server.ts";
import { registerAllTools } from "../src/tools/index.ts";
import type { AuthInfo } from "../src/types.ts";

interface FixtureStep {
  tool: string;
  arguments: Record<string, unknown>;
  expectation: {
    is_error: boolean;
    text?: string;
    json?: unknown;
  };
}

interface ServerFixture {
  id: string;
  description: string;
  capability: string;
  providers: string[];
  auth: {
    role: AuthInfo["role"];
    client_id: string;
    namespace_source?: AuthInfo["namespaceSource"];
  };
  steps: FixtureStep[];
}

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;
const fixtureDir = new URL("./server/", import.meta.url);
const fixtureGlob = new Bun.Glob("*.fixture.json");
const fixtures: ServerFixture[] = [];

for await (const name of fixtureGlob.scan({
  cwd: fixtureDir.pathname,
  onlyFiles: true,
})) {
  fixtures.push((await Bun.file(new URL(name, fixtureDir)).json()) as ServerFixture);
}
fixtures.sort((a, b) => a.id.localeCompare(b.id));

function replacePlaceholders(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === "string") {
    return Object.entries(replacements).reduce(
      (result, [placeholder, replacement]) => result.replaceAll(placeholder, replacement),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replacePlaceholders(item, replacements),
      ]),
    );
  }
  return value;
}

function expectObserved(actual: unknown, expected: unknown): void {
  if (expected === "<uuid>") {
    expect(actual).toBeString();
    expect(actual as string).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    return;
  }
  if (expected === "<iso-date>") {
    expect(actual).toBeString();
    expect(Number.isNaN(Date.parse(actual as string))).toBe(false);
    return;
  }
  if (expected === "<non-empty-string>") {
    expect(actual).toBeString();
    expect((actual as string).length).toBeGreaterThan(0);
    return;
  }
  if (Array.isArray(expected)) {
    expect(actual).toBeArray();
    expect((actual as unknown[]).length).toBe(expected.length);
    expected.forEach((item, index) => expectObserved((actual as unknown[])[index], item));
    return;
  }
  if (expected && typeof expected === "object") {
    expect(actual).toBeObject();
    for (const [key, value] of Object.entries(expected)) {
      expectObserved((actual as Record<string, unknown>)[key], value);
    }
    return;
  }
  expect(actual).toEqual(expected);
}

async function createClient(auth: AuthInfo): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  const server = createBrainServer();
  registerAllTools(server, {
    pool,
    embedFn: async () => Array(768).fill(0.01),
    mcpAuditConfig: {
      enabled: false,
      retentionDays: 30,
      cleanupIntervalMs: 86_400_000,
      writeTimeoutMs: 250,
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(
      message,
      { ...options, authInfo: auth } as unknown as Parameters<
        typeof originalSend
      >[1],
    );
  const client = new Client({ name: "server-parity", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

dbDescribe("current-src server parity fixtures (live Postgres)", () => {
  for (const fixture of fixtures) {
    test(fixture.id, async () => {
      const namespace = `${fixture.auth.client_id}-${process.pid}`;
      const replacements = {
        "{{namespace}}": namespace,
        "{{other_namespace}}": `${namespace}-other`,
      };
      const auth: AuthInfo = {
        role: fixture.auth.role,
        clientId: namespace,
        namespaceSource: fixture.auth.namespace_source ?? "token",
      };
      const { client, close } = await createClient(auth);
      try {
        for (const step of fixture.steps) {
          const args = replacePlaceholders(step.arguments, replacements) as Record<string, unknown>;
          const expected = replacePlaceholders(step.expectation, replacements) as FixtureStep["expectation"];
          const result = await client.callTool({ name: step.tool, arguments: args });
          const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
          if (process.env.PARITY_OBSERVE === "1") {
            process.stdout.write(`${fixture.id} ${step.tool}: ${JSON.stringify({ is_error: result.isError === true, text })}\n`);
          }
          expect(result.isError === true).toBe(expected.is_error);
          if (expected.text !== undefined) expect(text).toBe(expected.text);
          if (expected.json !== undefined) expectObserved(JSON.parse(text), expected.json);
        }
      } finally {
        await close();
      }
    });
  }
});

afterAll(async () => {
  await pool?.end();
});
