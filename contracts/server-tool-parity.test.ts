import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { Pool } from "pg";
import { createBrainServer } from "../src/server.ts";
import { registerAllTools } from "../src/tools/index.ts";
import type { AuthInfo } from "../src/types.ts";
import { registerMemoryTools } from "../server/tools/index.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "../server/tools/shared-namespace-fixture.ts";

interface FixtureStep {
  tool: string;
  arguments: Record<string, unknown>;
  /**
   * Bind values out of THIS step's response JSON for later steps to substitute.
   *
   * Maps a placeholder name to a dot path into the parsed response, e.g.
   * `{ "source_id": "source.id" }` makes `{{source_id}}` usable downstream.
   *
   * Mutations keyed by a server-generated id (`update_source`, `remove_source`)
   * cannot be expressed without this: their `id` does not exist until a prior
   * step creates the row, and the namespace placeholders are known before the
   * run. Capturing the id from the observed response keeps the fixture a
   * recording of real behavior rather than a hand-written guess at an id.
   */
  capture?: Record<string, string>;
  expectation: {
    is_error: boolean;
    text?: string;
    json?: unknown;
  };
}

type ProviderId = "current-src" | "server-rewrite-scaffold";
type CapabilityStatus = "implemented" | "scaffold-declared";

interface ServerFixture {
  id: string;
  description: string;
  capability: string;
  providers: ProviderId[];
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
  fixtures.push(
    (await Bun.file(new URL(name, fixtureDir)).json()) as ServerFixture,
  );
}
fixtures.sort((a, b) => a.id.localeCompare(b.id));
const parityManifest = (await Bun.file(
  new URL("./server/parity-manifest.json", import.meta.url),
).json()) as {
  provider_capability_status: Record<
    ProviderId,
    Record<string, CapabilityStatus>
  >;
};
const providers: ProviderId[] = ["current-src", "server-rewrite-scaffold"];

function replacePlaceholders(
  value: unknown,
  replacements: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    return Object.entries(replacements).reduce(
      (result, [placeholder, replacement]) =>
        result.replaceAll(placeholder, replacement),
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

/**
 * Read a dot path out of a parsed tool response.
 *
 * @returns The value at that path, or `undefined` when any segment is missing.
 */
function valueAtPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

function expectObserved(actual: unknown, expected: unknown): void {
  if (expected === "<uuid>") {
    expect(actual).toBeString();
    expect(actual as string).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
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
    expected.forEach((item, index) =>
      expectObserved((actual as unknown[])[index], item),
    );
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

async function createClient(
  provider: ProviderId,
  auth: AuthInfo,
): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  const server = createBrainServer();
  if (provider === "current-src") {
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
  }
  if (provider === "server-rewrite-scaffold") {
    registerMemoryTools(server, {
      pool,
      embedFn: async () => Array(768).fill(0.01),
      logger: pino({ level: "silent" }),
      embeddingModel: "parity-fixture",
      sharedNamespaceNames: isolatedSharedNamespaceNames(),
    });
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: auth,
    } as unknown as Parameters<typeof originalSend>[1]);
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

// Every fixture describes behavior in an EMPTY ISOLATED namespace. The unique
// per-run client namespace only delivers half of that: src/read-policy.ts
// readableNamespaces() correctly grants every non-admin role read access to the
// shared namespace as well (#147/#167), so with the default `shared-kb` the
// fixtures also observe whatever the target database happens to hold there. The
// recorded expectations were frozen against a database whose shared-kb was
// empty, which made them assert an accident of that database instead of the
// contract. Repointing the shared namespace at a unique per-run value that no
// row can belong to restores the intended premise for BOTH providers without
// changing production behavior, because sharedNamespaceConfig() resolves this
// from the environment on every call.
//
// The override is installed and REMOVED around this suite rather than at module
// scope. Bun runs every test file in one process and `sharedNamespaceConfig()`
// re-reads the environment on every call, so a module-scope assignment is a
// process-wide mutation that outlives this file: the legacy-collab fallback
// tests in `src/tools/__tests__/search-brain.test.ts` (and the repo-fact,
// brain_answer, and search_all fallback suites) assert against the real
// `shared-kb`/`collab` pair and fail purely from load order. Measured on this
// branch: `bun test src/tools/__tests__/search-brain.test.ts` alone is 40/0,
// and with this file added it is 5 failures — the same 5 that appear in the
// full run. Scoping the assignment to the suite keeps the isolated premise for
// these fixtures and leaves every sibling file the environment it recorded
// against.
const SHARED_NAMESPACE_ISOLATION = `parity-shared-${process.pid}-${Date.now()}`;
const priorSharedNamespaceEnv = {
  canonical: process.env.SHARED_NAMESPACE_CANONICAL,
  physical: process.env.SHARED_NAMESPACE_PHYSICAL,
};

/**
 * The shared-namespace name set the `server-rewrite-scaffold` provider is wired
 * with.
 *
 * `server/tools/shared-namespace.ts` reads no environment (#857): every name
 * arrives through `MemoryToolDependencies.sharedNamespaceNames`, exactly as
 * `server/main.ts` supplies it from `ServerConfig`. The env assignments above
 * still isolate the `current-src` provider, which resolves those names itself;
 * this returns the same isolated pair as an explicit dependency so BOTH
 * providers observe the identical premise.
 */
function isolatedSharedNamespaceNames(): typeof DEFAULT_SHARED_NAMESPACE_NAMES {
  return {
    ...DEFAULT_SHARED_NAMESPACE_NAMES,
    canonicalSharedNamespace: SHARED_NAMESPACE_ISOLATION,
    physicalSharedNamespace: SHARED_NAMESPACE_ISOLATION,
  };
}

/** Restore an env var to its pre-suite value, unsetting it when it was absent. */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// Every namespace this suite writes into, recorded as each test builds one.
// Teardown deletes exactly these — not a `parity-%` wildcard sweep, which would
// also delete a concurrently running lane's rows out from under it, and not a
// hardcoded list, which silently stops covering a fixture the moment one is
// added.
const seededNamespaces = new Set<string>();

// Tables the fixtures actually write, in FOREIGN-KEY-SAFE order.
//
// Measured, not guessed: a full parity run against a freshly migrated database
// left rows in exactly these, and only these, under `parity-%` namespaces
// (#613). Children precede their parents — `ob_raw_turns` references
// `ob_session_lanes`, and `ob_source_files` references `ob_sources` — so a
// delete in list order never trips a constraint.
//
// This list is deliberately explicit rather than derived from
// `information_schema` at runtime. A schema-walking teardown would silently
// widen its own blast radius every time a namespaced table is added, which is
// the opposite of what a test fixture should do; when a new fixture starts
// writing somewhere new, the done-means check (#613) fails and this list is
// updated on purpose.
const SEEDED_TABLES = [
  "ob_raw_turns",
  "ob_session_lanes",
  "ob_source_files",
  "ob_sources",
  "ob_links",
  "ob_entities",
  "content_occurrences",
  "decisions",
  "relationships",
  "sessions",
  "thoughts",
] as const;

/**
 * Delete every row this suite seeded, in every namespace it used.
 *
 * WHY THIS EXISTS (#613): these fixtures were leaving approved/active
 * `ob_sources` rows behind. On `main` that was invisible because nothing
 * produced from them. The maintenance sweep is a CROSS-NAMESPACE producer by
 * design (`selectSourcesNeedingDerivation` receives `undefined` writable
 * namespaces, because a server-owned sweep must serve every namespace), so the
 * moment a producer runs anywhere in the suite, these leftovers become real
 * queued `graph.derive` jobs and break an unrelated test — observed in PR #609
 * as `026 maintenance queue` losing its concurrent-claim race (Expected 1,
 * Received 2). A suite that leaks rows is not a self-contained suite; it is a
 * time bomb for whoever next turns on a producer.
 */
async function deleteSeededRows(): Promise<void> {
  if (!pool || seededNamespaces.size === 0) return;
  const namespaces = [...seededNamespaces];
  for (const table of SEEDED_TABLES) {
    await pool.query(`DELETE FROM ${table} WHERE namespace = ANY($1)`, [
      namespaces,
    ]);
  }
}

dbDescribe(
  "server parity fixtures by implemented provider capability (live Postgres)",
  () => {
    beforeAll(() => {
      process.env.SHARED_NAMESPACE_CANONICAL = SHARED_NAMESPACE_ISOLATION;
      process.env.SHARED_NAMESPACE_PHYSICAL = SHARED_NAMESPACE_ISOLATION;
    });

    afterAll(async () => {
      // Delete BEFORE restoring the shared-namespace override. The deletes are
      // plain namespace-predicated SQL and do not read that config, so the order
      // is not load-bearing today — but keeping cleanup inside the isolated
      // window means it stays correct if a future teardown ever routes through
      // application code that resolves the shared namespace.
      await deleteSeededRows();
      restoreEnv(
        "SHARED_NAMESPACE_CANONICAL",
        priorSharedNamespaceEnv.canonical,
      );
      restoreEnv("SHARED_NAMESPACE_PHYSICAL", priorSharedNamespaceEnv.physical);
    });

    for (const provider of providers) {
      for (const fixture of fixtures) {
        if (
          parityManifest.provider_capability_status[provider][
            fixture.capability
          ] !== "implemented"
        )
          continue;
        test(`${provider}: ${fixture.id}`, async () => {
          const providerSlug = provider.replaceAll("-", "_");
          const namespace = `${fixture.auth.client_id}-${providerSlug}-${process.pid}`;
          const otherNamespace = `${namespace}-other`;
          // Recorded BEFORE the steps run, not after. A fixture that throws
          // partway has still written rows, and those are exactly the ones most
          // worth cleaning up; registering on the way in makes teardown cover the
          // failure path too.
          seededNamespaces.add(namespace);
          seededNamespaces.add(otherNamespace);
          // Captured ids are added to this same map as steps run, so a fixture
          // substitutes namespace tokens and prior-step ids through one mechanism.
          const replacements: Record<string, string> = {
            "{{namespace}}": namespace,
            "{{other_namespace}}": otherNamespace,
          };
          const auth: AuthInfo = {
            role: fixture.auth.role,
            clientId: namespace,
            namespaceSource: fixture.auth.namespace_source ?? "token",
          };
          const { client, close } = await createClient(provider, auth);
          try {
            for (const step of fixture.steps) {
              const args = replacePlaceholders(
                step.arguments,
                replacements,
              ) as Record<string, unknown>;
              const expected = replacePlaceholders(
                step.expectation,
                replacements,
              ) as FixtureStep["expectation"];
              const result = await client.callTool({
                name: step.tool,
                arguments: args,
              });
              const text =
                (result.content as Array<{ text: string }>)[0]?.text ?? "";
              if (process.env.PARITY_OBSERVE === "1") {
                process.stdout.write(
                  `${provider} ${fixture.id} ${step.tool}: ${JSON.stringify({ is_error: result.isError === true, text })}\n`,
                );
              }
              expect(result.isError === true).toBe(expected.is_error);
              if (expected.text !== undefined) expect(text).toBe(expected.text);
              if (expected.json !== undefined)
                expectObserved(JSON.parse(text), expected.json);

              for (const [name, path] of Object.entries(step.capture ?? {})) {
                const captured = valueAtPath(JSON.parse(text), path);
                // A capture that silently resolved to undefined would substitute
                // the literal string "undefined" into the next step's arguments,
                // turning a broken fixture into a confusing validation error
                // several steps later. Fail here, where the cause is visible.
                expect(
                  typeof captured === "string" && captured.length > 0,
                  `${fixture.id} step ${step.tool}: capture '${name}' found nothing at '${path}'`,
                ).toBe(true);
                replacements[`{{${name}}}`] = captured as string;
              }
            }
          } finally {
            await close();
          }
        });
      }
    }
  },
);

afterAll(async () => {
  await pool?.end();
});
