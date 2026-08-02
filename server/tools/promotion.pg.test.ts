/**
 * Live-Postgres behavior tests for the ported promotion and repo-fact tools.
 *
 * THE REPO RULE THIS EXISTS FOR: `promote_shared` must accept and test
 * `target_namespace`, with the legacy `collab` name treated as an INTERNAL
 * MIGRATION SOURCE ONLY. The parity fixture freezes the identity refusal for a
 * non-promoter; only a seeded test with a real promoter identity can prove what
 * happens once the caller IS authorized -- which is where the interesting rules
 * live: the legacy target is refused, the dry-run default writes nothing, and
 * secret/private content is refused even for an authorized promoter.
 *
 * Skips loudly (via `describe.skip`) when `OPENBRAIN_TEST_DATABASE_URL` is
 * unset. It must point at an isolated test/playground database, never the
 * dogfood database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { registerPromotionTools } from "./promotion.ts";
import { sharedNamespaceConfig } from "../../src/shared-namespace.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;

const NAMESPACE = `promotion-pg-${process.pid}`;
const SHARED = sharedNamespaceConfig();

async function callTool(
  tool: string,
  namespace: string,
  args: Record<string, unknown>,
  role = "promoter",
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  const server = new McpServer({ name: "promotion-test", version: "1.0.0" });
  registerPromotionTools(server, {
    pool,
    embedFn: async () => Array(768).fill(0.01) as number[],
    logger: pino({ level: "silent" }),
    embeddingModel: "promotion-test",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role, clientId: namespace, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "promotion-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { isError: result.isError === true, body };
  } finally {
    await client.close();
    await server.close();
  }
}

async function sharedCount(content: string): Promise<number> {
  const { rows } = await pool!.query(
    `SELECT COUNT(*)::int AS cnt FROM thoughts
      WHERE namespace = $1 AND content = $2 AND archived_at IS NULL`,
    [SHARED.physicalSharedNamespace, content],
  );
  return rows[0].cnt;
}

const SHAREABLE = "The parity harness resolves each provider through the TOOLS_BOUNDARY seam.";
/**
 * Content the classifier must refuse, written as a URL with inline userinfo.
 *
 * Deliberately NOT a token-shaped literal. An earlier draft used a fake
 * `ghp_`-prefixed string, which is exactly what a credential scanner is built
 * to flag -- and GitGuardian duly failed the PR on it. A fake secret in a
 * fixture still costs a real triage, so this uses the `url_userinfo_credential`
 * detector instead: it exercises the same `reject-secret` path with a shape no
 * scanner mistakes for a live key.
 */
const SECRET_ISH =
  "The staging database is reachable at postgres://svc-user:hunter2horse@db.internal:5432/appdb which is why the job works.";

dbDescribe("promote_shared and list_namespaces (live Postgres)", () => {
  let shareableId = "";
  let secretId = "";

  beforeAll(async () => {
    const shareable = await pool!.query(
      `INSERT INTO thoughts (content, namespace, created_by) VALUES ($1, $2, $2) RETURNING id`,
      [SHAREABLE, NAMESPACE],
    );
    shareableId = shareable.rows[0].id;
    const secret = await pool!.query(
      `INSERT INTO thoughts (content, namespace, created_by) VALUES ($1, $2, $2) RETURNING id`,
      [SECRET_ISH, NAMESPACE],
    );
    secretId = secret.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM thoughts WHERE namespace = $1`, [NAMESPACE]);
    await pool.query(
      `DELETE FROM thoughts WHERE namespace = $1 AND content = ANY($2::text[])`,
      [SHARED.physicalSharedNamespace, [SHAREABLE, SECRET_ISH]],
    );
    await pool.end();
  });

  test("the dry-run default previews and writes NOTHING to shared truth", async () => {
    const before = await sharedCount(SHAREABLE);
    const { isError } = await callTool("promote_shared", NAMESPACE, {
      table: "thoughts",
      id: shareableId,
    });
    expect(isError).toBe(false);
    expect(await sharedCount(SHAREABLE)).toBe(before);
  });

  test("the legacy 'collab' name is refused as a promotion target", async () => {
    // Refused by NAME, not by config: `legacySharedNamespace` is empty in the
    // default deployment, so a config-gated check would let `collab` through
    // exactly where it matters most.
    const { isError, body } = await callTool("promote_shared", NAMESPACE, {
      table: "thoughts",
      id: shareableId,
      target_namespace: "collab",
      dry_run: false,
    });
    expect(isError).toBe(true);
    expect(String(body.text)).toContain("legacy migration source");
    // And nothing landed under the legacy name either.
    const { rows } = await pool!.query(
      `SELECT COUNT(*)::int AS cnt FROM thoughts WHERE namespace = 'collab' AND content = $1`,
      [SHAREABLE],
    );
    expect(rows[0].cnt).toBe(0);
  });

  test("an explicit canonical target_namespace is accepted and writes", async () => {
    const { isError, body } = await callTool("promote_shared", NAMESPACE, {
      table: "thoughts",
      id: shareableId,
      target_namespace: SHARED.canonicalSharedNamespace,
      dry_run: false,
      reason: "parity coverage for the target_namespace argument",
    });
    expect(isError).toBe(false);
    expect(body.classification).toBe("share");
    expect(await sharedCount(SHAREABLE)).toBe(1);
  });

  test("secret-like content is refused even for an authorized promoter", async () => {
    const before = await sharedCount(SECRET_ISH);
    const { isError, body } = await callTool("promote_shared", NAMESPACE, {
      table: "thoughts",
      id: secretId,
      dry_run: false,
    });
    expect(isError).toBe(true);
    // Authorization is permission to promote shareable content, not permission
    // to override the content gate.
    expect(String(body.text)).toContain("Refused");
    expect(await sharedCount(SECRET_ISH)).toBe(before);
  });

  test("a plain agent identity cannot promote at all", async () => {
    const { isError, body } = await callTool(
      "promote_shared",
      NAMESPACE,
      { table: "thoughts", id: shareableId, dry_run: false },
      "agent",
    );
    expect(isError).toBe(true);
    expect(String(body.text)).toContain("requires the promoter, admin, or ob-admin identity");
  });

  test("a promoter reads across namespaces BY DESIGN, unlike a lane identity", async () => {
    // Documented, not incidental: `docs/decisions/admin-and-promoter-identities.md`
    // grants the promoter identity cross-namespace work, and
    // `namespacePredicate` returns an empty clause for it. Asserting a refusal
    // here would encode the opposite of the design and fail for the right code.
    const asPromoter = await callTool(
      "promote_shared",
      `${NAMESPACE}-stranger`,
      { table: "thoughts", id: shareableId },
    );
    expect(asPromoter.isError).toBe(false);

    // The lane-scoped identity is where the boundary actually binds. An agent
    // never reaches promote_shared's read at all -- it is refused by identity
    // first -- so the read boundary is proven through list_namespaces instead.
    const stranger = await callTool(
      "list_namespaces",
      `${NAMESPACE}-stranger`,
      {},
      "agent",
    );
    const namespaces = stranger.body.namespaces as Array<{ namespace: string }>;
    expect(namespaces.map((entry) => entry.namespace)).not.toContain(NAMESPACE);
  });

  test("list_namespaces reports per-table counts for the caller's lane", async () => {
    const { isError, body } = await callTool("list_namespaces", NAMESPACE, {}, "admin");
    expect(isError).toBe(false);
    const namespaces = body.namespaces as Array<{
      namespace: string;
      total: number;
      per_table: Record<string, number>;
    }>;
    const own = namespaces.find((entry) => entry.namespace === NAMESPACE);
    expect(own?.per_table.thoughts).toBe(2);
    expect(own?.total).toBe(2);
  });
});
