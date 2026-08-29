/**
 * Driver for the #605 DONE-MEANS check. Not a test file; invoked by
 * scripts/done-means/605-chunk-write-routing.sh, which owns the verdict.
 *
 * Each of the three thought-write paths named in #605 is driven at its REAL
 * entry point against the dogfood database, with a long thought (over
 * CHUNK_THRESHOLD), in a throwaway namespace this script seeds and the shell
 * script tears down:
 *
 *   rewrite-tree log_thought  -> the registered MCP tool handler from
 *                                server/tools/capture.ts, invoked through a
 *                                real McpServer + in-memory transport.
 *   REST POST /api/v1/thoughts -> the router from server/transport/rest-api.ts, on
 *                                a real express app, reached over HTTP.
 *   lane graduation            -> graduateLaneEvent() from src/tiering.ts.
 *
 * The embedding PROVIDER is stubbed with a deterministic vector so the check
 * does not depend on a live MLX endpoint. Everything else -- routing, SQL,
 * parent linkage -- is the production code path against real Postgres.
 *
 * Output is one JSON object written to the path in DONE_MEANS_605_OUT: per-path
 * parent id and the tally of chunk rows found with parent_id = that parent. No
 * content, no credentials.
 *
 * It goes to a FILE, not stdout, because the application logger this code path
 * legitimately uses writes its own JSON lines to stdout — including the
 * `entry_chunk_write_*` lines this very fix emits. Parsing stdout made the
 * shell read a log line as the result and report "no parent id" for paths that
 * had in fact succeeded, i.e. a false FAIL produced by the harness.
 */
import { Pool } from "pg";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { createRestRouter, type RestDeps } from "../../server/transport/rest-api.ts";
import { registerCaptureTools } from "../../server/tools/capture.ts";
import { graduateLaneEvent } from "../../src/tiering.ts";
import { EMBEDDING_DIMENSIONS } from "../../src/embedding.ts";
import { CHUNK_THRESHOLD } from "../../src/chunking.ts";

if (
  !process.env.DONE_MEANS_605_NS ||
  !process.env.DONE_MEANS_605_MARKER ||
  !process.env.DONE_MEANS_605_OUT
) {
  console.error(
    "DONE_MEANS_605_NS, DONE_MEANS_605_MARKER and DONE_MEANS_605_OUT are required",
  );
  process.exit(3);
}
const NS: string = process.env.DONE_MEANS_605_NS;
const MARKER: string = process.env.DONE_MEANS_605_MARKER;
const OUT_PATH: string = process.env.DONE_MEANS_605_OUT;

const CREATED_BY = "done-means-605";

/** A thought comfortably over CHUNK_THRESHOLD, so chunking must engage. */
function longThought(tag: string): string {
  const sentence =
    `Routing probe ${MARKER} ${tag}: every thought write must reach the chunk ` +
    `writer so a long entry lands as a complete parent plus per-section rows. `;
  let text = "";
  while (text.length < CHUNK_THRESHOLD * 3) text += sentence;
  return text;
}

const stubEmbed = async (): Promise<number[]> => Array(EMBEDDING_DIMENSIONS).fill(0.01);

const pool = new Pool();

async function chunkCount(parentId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM thoughts WHERE parent_id = $1`,
    [parentId],
  );
  return rows[0].n as number;
}

/** Path 1 -- rewrite-tree log_thought, through a real MCP client/server pair. */
async function driveCapture(): Promise<string> {
  const server = new McpServer({ name: "done-means-605", version: "0" });
  registerCaptureTools(
    server as unknown as Parameters<typeof registerCaptureTools>[0],
    {
      pool,
      embedFn: stubEmbed,
      logger: pino({ level: "silent" }),
    } as unknown as Parameters<typeof registerCaptureTools>[1],
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "done-means-605-client", version: "0" });
  // The handler reads identity from extra.authInfo, which the transport
  // carries per-request; InMemoryTransport forwards what we attach here.
  const transportHooks = serverTransport as unknown as {
    onmessage_authInfo?: unknown;
    onmessage?: (msg: unknown, extra?: Record<string, unknown>) => void;
  };
  transportHooks.onmessage_authInfo = undefined;
  await client.connect(clientTransport);

  // Attach auth to every request the server sees.
  const origOnMessage = transportHooks.onmessage;
  transportHooks.onmessage = (msg: unknown, extra?: Record<string, unknown>) => {
    origOnMessage?.(msg, {
      ...extra,
      authInfo: { role: "admin", clientId: CREATED_BY, namespaceSource: "token" },
    });
  };

  const result = (await client.callTool({
    name: "log_thought",
    arguments: { content: longThought("capture"), namespace: NS },
  })) as { content?: { text?: string }[] };
  await client.close();
  await server.close();

  const text = result?.content?.[0]?.text ?? "";
  const payload = JSON.parse(text);
  if (!payload.id) throw new Error(`capture path returned no id: ${text}`);
  return payload.id as string;
}

/** Path 2 -- REST POST /api/v1/thoughts, over real HTTP. */
async function driveRest(): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { auth: unknown }).auth = {
      role: "admin",
      clientId: CREATED_BY,
    };
    next();
  });
  app.use(
    "/api/v1",
    createRestRouter({ pool, embedFn: stubEmbed as unknown as RestDeps["embedFn"] }),
  );

  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://127.0.0.1:${port}/api/v1/thoughts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: longThought("rest"), namespace: NS }),
  });
  const body = (await res.json()) as { id?: string };
  await new Promise<void>((r) => server.close(() => r()));

  if (!body?.id) throw new Error(`rest path returned no id: ${JSON.stringify(body)}`);
  return body.id as string;
}

/** Path 3 -- lane graduation. */
async function driveGraduation(): Promise<string> {
  const content = longThought("graduation");
  const result = await graduateLaneEvent(
    pool,
    {
      id: "00000000-0000-4000-8000-000000000605",
      lane_id: "00000000-0000-4000-8000-000000000606",
      session_key: `done-means-605-${MARKER}`,
      event_type: "fact",
      content,
      content_hash: null,
      importance: 5,
      agent: CREATED_BY,
      namespace: NS,
    } as unknown as Parameters<typeof graduateLaneEvent>[1],
    NS,
    CREATED_BY,
    await stubEmbed(),
    "done-means-605 routing probe",
    stubEmbed,
  );
  return result.thought_id;
}

async function main() {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of [
    ["capture", driveCapture],
    ["rest", driveRest],
    ["graduation", driveGraduation],
  ] as const) {
    try {
      const parentId = await fn();
      out[name] = { parent_id: parentId, chunks: await chunkCount(parentId) };
    } catch (error) {
      out[name] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  await Bun.write(OUT_PATH, JSON.stringify(out));
  await pool.end();
}

await main();
