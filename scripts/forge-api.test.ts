/**
 * forge-api tests — a real HTTP fixture on loopback, no network beyond
 * 127.0.0.1 and no `process.env` reads: the environment is injected as a plain
 * object, which is why every exported function takes one.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  ForgeApiError,
  forgeApiBase,
  forgeGet,
  forgeListComments,
  forgePost,
} from "./forge-api.ts";

let port = 0; // assigned by the OS at listen (issue 1657)
const TOKEN = "test-token";

type Seen = { auth: string | null; contentType: string | null; body: string };

let server: Server;
let lastPost: Seen | null = null;
let lastGetAuth: string | null = null;

/**
 * The fixture's routing, written against the Web `Request`/`Response` pair so
 * the assertions below read the same objects they always did. Issue 751 moved
 * the listener itself from a bun-only server to node:http; this function is
 * unchanged.
 */
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/issues/7/comments") {
    lastPost = {
      auth: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body: await request.text(),
    };
    return Response.json({ id: 99 });
  }
  lastGetAuth = request.headers.get("authorization");
  if (url.pathname === "/pulls/1") {
    return Response.json({ number: 1, state: "open" });
  }
  if (url.pathname === "/issues/6/comments") {
    // A server that ignores ?page= and repeats itself, observed live.
    return Response.json([{ id: 1, body: "a", created_at: "t1" }]);
  }
  if (url.pathname === "/issues/5/comments") {
    const page = url.searchParams.get("page");
    if (page === "1") {
      return Response.json([{ id: 1, body: "a", created_at: "t1" }]);
    }
    if (page === "2") {
      return Response.json([{ id: 2, body: "b", created_at: "t2" }]);
    }
    return Response.json([]);
  }
  return new Response("no such thing", { status: 404 });
}

/** Reads the whole request body, or nothing for the methods that have none. */
async function readBody(incoming: IncomingMessage): Promise<Buffer | undefined> {
  if (incoming.method === "GET" || incoming.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Adapts one node:http exchange onto the Web-shaped `handle` above. */
async function serve(incoming: IncomingMessage, outgoing: ServerResponse) {
  const body = await readBody(incoming);
  const request = new Request(
    new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`).href,
    {
      method: incoming.method ?? "GET",
      headers: incoming.headers as Record<string, string>,
      ...(body && body.length > 0 ? { body } : {}),
    },
  );
  const response = await handle(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

beforeAll(async () => {
  server = createServer((incoming, outgoing) => void serve(incoming, outgoing));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("forge-api fixture has no TCP address");
  }
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function env(): Record<string, string | undefined> {
  return {
    OPEN_BRAIN_FORGE_API_BASE: `http://127.0.0.1:${port}`,
    OPEN_BRAIN_FORGE_TOKEN: TOKEN,
  };
}

describe("forge-api", () => {
  test("forgeGet sends the token header and returns parsed JSON", async () => {
    const pull = await forgeGet<{ number: number; state: string }>("/pulls/1", env());
    expect(pull).toEqual({ number: 1, state: "open" });
    expect(lastGetAuth).toBe(`token ${TOKEN}`);
  });

  test("forgePost sends the JSON body and the content type", async () => {
    const created = await forgePost<{ id: number }>(
      "/issues/7/comments",
      { body: "receipt" },
      env(),
    );
    expect(created).toEqual({ id: 99 });
    expect(lastPost?.contentType).toBe("application/json");
    expect(lastPost?.body).toBe(JSON.stringify({ body: "receipt" }));
  });

  test("a 404 throws ForgeApiError naming the status and never the token", async () => {
    let caught: unknown;
    try {
      await forgeGet("/pulls/does-not-exist", env());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForgeApiError);
    const message = (caught as Error).message;
    expect(message).toContain("404");
    expect(message).not.toContain(TOKEN);
    expect((caught as ForgeApiError).detail).not.toContain(TOKEN);
  });

  test("forgeListComments concatenates pages and stops on the empty one", async () => {
    const comments = await forgeListComments(5, env());
    expect(comments.map((c) => c.id)).toEqual([1, 2]);
  });

  test("forgeListComments stops when a page repeats instead of looping forever", async () => {
    const comments = await forgeListComments(6, env());
    expect(comments.map((c) => c.id)).toEqual([1]);
  });

  test("forgeApiBase strips a trailing slash from the env value", () => {
    expect(
      forgeApiBase({
        OPEN_BRAIN_FORGE_API_BASE: "https://git.example/api/v1/repos/a/b/",
      }),
    ).toBe("https://git.example/api/v1/repos/a/b");
  });
});
