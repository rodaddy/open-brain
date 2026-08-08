/**
 * Driver for the #563 DONE-MEANS check. Not a test file; invoked by
 * scripts/done-means/563-bounded-recall.sh, which owns the verdict.
 *
 * WHAT IT DRIVES
 * --------------
 * The real `agent_context_pack` MCP tool (src/tools/agent-context-pack.ts,
 * registered on a real McpServer over an in-memory transport) against real
 * Postgres, in a throwaway namespace this driver seeds and the shell script
 * tears down. Nothing about the retrieval, section assembly, or pointer
 * derivation is stubbed — only the embedding PROVIDER, with a deterministic
 * vector, so the check does not depend on a live MLX endpoint.
 *
 * WHAT IT MEASURES (operator ruling 2026-08-08, ledger item 23)
 * -------------------------------------------------------------
 * A budgetless, broad `durable_memory` request must not be answerable as one
 * whole-corpus payload — "I don't see any reason why this whole thing would
 * ship in a single shot to anywhere." Recall answers with a bounded burst plus
 * the pointer pool the pack already builds (docs/agent-context-pack-contract.md
 * "Response Shape": `pointers` is the designated follow-up-fetch surface), and
 * a caller that legitimately wants all of it walks those pointers in further
 * bursts. This is response SHAPE. No record is dropped, nothing is stored
 * smaller, and the walk must reconstruct the complete recalled set.
 *
 * The driver performs the walk and reports what it observed. It renders NO
 * verdict — every threshold lives in the shell script.
 *
 * OUTPUT
 * ------
 * One JSON object written to the path in DONE_MEANS_563_OUT: seeded row count,
 * per-burst item counts and identities, per-burst serialized byte sizes, the
 * union of identities the walk retrieved, and how many requests the walk took.
 * No record bodies, no credentials.
 *
 * It goes to a FILE, not stdout, because this code path legitimately writes
 * application log lines to stdout; parsing stdout would let a log line be read
 * as the result (the #605 driver's recorded false-FAIL).
 */
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAgentContextPack } from "../../src/tools/agent-context-pack.ts";
import type { ToolDeps } from "../../src/tools/index.ts";
import type { AuthInfo } from "../../src/types.ts";
import { WorkingSetStore } from "../../src/realtime/working-set.ts";
import { RecoveryWalStore } from "../../src/realtime/recovery-wal.ts";
import { EMBEDDING_DIMENSIONS } from "../../src/embedding.ts";

if (
  !process.env.DONE_MEANS_563_NS ||
  !process.env.DONE_MEANS_563_MARKER ||
  !process.env.DONE_MEANS_563_OUT
) {
  console.error(
    "DONE_MEANS_563_NS, DONE_MEANS_563_MARKER and DONE_MEANS_563_OUT are required",
  );
  process.exit(3);
}
const NS: string = process.env.DONE_MEANS_563_NS;
const MARKER: string = process.env.DONE_MEANS_563_MARKER;
const OUT_PATH: string = process.env.DONE_MEANS_563_OUT;

/**
 * How many records the throwaway probe corpus holds. Deliberately several times
 * any plausible burst size, so "one burst" and "the whole corpus" are far apart
 * and a walk has real work to do. A property of the PROBE CORPUS only; it
 * constrains nothing the server stores or returns.
 */
const SEEDED_RECORDS = 60;

/** A body large enough that a whole-corpus reply is unmistakably large. */
const BODY_CHARS = 1200;

/** Stops a runaway walk if a continuation handle never terminates. */
const WALK_REQUEST_CEILING = 200;

const pool = new Pool();

const stubEmbed = async (): Promise<number[]> =>
  Array(EMBEDDING_DIMENSIONS).fill(0.01);

const SCOPE = {
  namespace: NS,
  agent: "done-means-563",
  platform: "cli",
  server_id: "done-means-563",
  channel_id: "done-means-563",
  session_key: `cli:done-means-563:${MARKER}`,
};

/**
 * The broad query. Every seeded record carries the marker, so this matches the
 * entire seeded corpus — the "broad request" half of the ruling.
 */
const BROAD_QUERY = `${MARKER} durable recall probe record`;

function body(index: number): string {
  const sentence =
    `${MARKER} durable recall probe record ${index}: this body exists so a ` +
    `whole-corpus reply would be unmistakably large and a bounded burst is ` +
    `distinguishable from it by inspection. `;
  let text = "";
  while (text.length < BODY_CHARS) text += sentence;
  return text;
}

async function seedCorpus(): Promise<number> {
  const embedding = `[${Array(EMBEDDING_DIMENSIONS).fill(0.01).join(",")}]`;
  let seeded = 0;
  for (let index = 0; index < SEEDED_RECORDS; index += 1) {
    await pool.query(
      `INSERT INTO decisions
         (id, namespace, title, rationale, created_by, embedding, tier)
       VALUES ($1, $2, $3, $4, $5, $6::halfvec, 'warm')`,
      [
        randomUUID(),
        NS,
        `${MARKER} probe decision ${index}`,
        body(index),
        "done-means-563",
        embedding,
      ],
    );
    seeded += 1;
  }
  return seeded;
}

type Burst = {
  request: number;
  item_count: number;
  identities: string[];
  pointer_identities: string[];
  serialized_bytes: number;
  has_continuation: boolean;
};

function identitiesOf(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const record = item as Record<string, unknown>;
      return typeof record.citation_id === "string" ? record.citation_id : null;
    })
    .filter((value): value is string => value !== null);
}

/**
 * Read a continuation handle from a reply, if the server offers one.
 *
 * Deliberately tolerant about WHERE the handle lives: the check must not
 * dictate the implementation's field naming, only that the remainder stays
 * reachable through a follow-up request. A reply with no handle ends the walk;
 * whether that is correct is the shell script's judgement, not the driver's.
 */
function continuationOf(section: Record<string, unknown>): unknown {
  const direct = section.next;
  if (direct !== undefined && direct !== null) return direct;
  const cursor = section.continuation;
  if (cursor !== undefined && cursor !== null) return cursor;
  return null;
}

async function main(): Promise<void> {
  const seeded = await seedCorpus();

  const server = new McpServer({ name: "done-means-563", version: "0" });
  const deps: ToolDeps = {
    pool: pool as never,
    embedFn: stubEmbed,
    workingSetStore: new WorkingSetStore(),
    recoveryWalStore: new RecoveryWalStore(),
  };
  registerAgentContextPack(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const auth: AuthInfo = { role: "admin", clientId: "done-means-563" };
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: never, options?: never) =>
    originalSend(message, { ...(options ?? {}), authInfo: auth } as never);

  const client = new Client({ name: "done-means-563", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const bursts: Burst[] = [];
  const union = new Set<string>();
  let continuation: unknown = null;
  let request = 0;

  // The FIRST request is the budgetless, broad one the ruling is about: a query
  // matching the whole seeded corpus, and no budget argument at all. Later
  // requests replay it carrying whatever continuation handle the server
  // returned — the paged walk.
  do {
    request += 1;
    const args: Record<string, unknown> = {
      ...SCOPE,
      query: BROAD_QUERY,
      requested_sections: ["durable_memory", "pointers"],
    };
    if (continuation !== null) args.continue_from = continuation;

    const reply = await client.callTool({
      name: "agent_context_pack",
      arguments: args,
    });

    const text = (reply as { content?: Array<{ text?: string }> }).content?.[0]
      ?.text;
    const serializedBytes = Buffer.byteLength(text ?? "", "utf8");
    const payload = JSON.parse(text ?? "{}") as Record<string, unknown>;
    const sections = (payload.sections ?? payload) as Record<string, unknown>;
    const durable = (sections.durable_memory ?? {}) as Record<string, unknown>;
    const pointers = (sections.pointers ?? {}) as Record<string, unknown>;

    const identities = identitiesOf(durable.items);
    const pointerIdentities = identitiesOf(pointers.items);
    const before = union.size;
    for (const identity of identities) union.add(identity);
    const progressed = union.size > before;

    continuation = continuationOf(durable);

    bursts.push({
      request,
      item_count:
        typeof durable.item_count === "number"
          ? durable.item_count
          : identities.length,
      identities,
      pointer_identities: pointerIdentities,
      serialized_bytes: serializedBytes,
      has_continuation: continuation !== null,
    });

    // A continuation that yields nothing new would loop forever. Stop and let
    // the shell judge a no-progress walk rather than spinning to the ceiling.
    if (!progressed) break;
  } while (continuation !== null && request < WALK_REQUEST_CEILING);

  await client.close();
  await server.close();

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        seeded,
        namespace: NS,
        marker: MARKER,
        requests: request,
        bursts,
        union_size: union.size,
        walk_ceiling_hit: request >= WALK_REQUEST_CEILING,
      },
      null,
      2,
    ),
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    try {
      writeFileSync(
        OUT_PATH,
        JSON.stringify({ driver_error: String(error) }, null, 2),
      );
    } catch {
      // The shell reports a missing/unreadable result file as a harness error.
    }
    await pool.end();
    process.exit(3);
  });
