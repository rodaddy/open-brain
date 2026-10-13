/**
 * A standalone HTTP listener for a WHATWG `(Request) => Response` handler,
 * built on `node:http`. Issue 751 cluster C.
 *
 * WHY THIS EXISTS. The repo's standalone HTTP surfaces (the grading page, the
 * two-worker proxy, the NATS worker's /health) were each a Bun-runtime server call
 * with a `fetch(req)` handler. The bun -> Node 24 migration removes the Bun
 * runtime, and `node:http` speaks a different object model entirely --
 * `(IncomingMessage, ServerResponse)`, not Request/Response. Rather than
 * rewrite three handlers into node's model and lose their testability (each is
 * currently exercised by calling it with a plain `Request`, no socket), this
 * module ports the MECHANISM once and leaves every handler unchanged.
 *
 * NO NEW DEPENDENCY. `node:http`, `node:stream`, and the global
 * Request/Response/Headers that Node 18+ ships. package.json is untouched.
 *
 * PORT CLASHES STAY LOUD. Bun's server THREW on a taken port; `node:http`
 * `listen` emits an asynchronous 'error' event and returns normally, so a
 * naive port would turn a hard failure into a silent one -- exactly what
 * `grading-server.ts` (module header, DEFAULT_GRADING_PORT) and
 * `scripts/grading-server-run.ts` depend on NOT happening. `serveFetch`
 * therefore returns a promise that REJECTS with the listen error, so a caller
 * that awaits it fails as loudly as Bun did.
 *
 * MATCH ON `err.code`, NOT THE MESSAGE. Under node the message is
 * "listen EADDRINUSE: address already in use ..."; under bun's `node:http`
 * shim the SAME clash arrives as "Failed to start server. Is port N in use?"
 * (observed 2026-09-03 running the 751 done-means driver under bun 1.3.13).
 * `err.code === "EADDRINUSE"` is what both set and is the only stable
 * discriminator across the two runtimes during the migration; a substring test
 * on the message passes on one runtime and silently fails on the other.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface ServeFetchOptions {
  port: number;
  hostname?: string;
  fetch: FetchHandler;
}

export interface FetchHttpServer {
  /** The port actually bound. Read back from the socket: port 0 means "any". */
  port: number;
  /**
   * Stop listening.
   *
   * `force` defaults to true and matches the Bun server's `stop(true)`: node's
   * `close()` alone waits for keep-alive sockets to drain and can hang a
   * shutdown path indefinitely, so idle and active connections are destroyed
   * first via `closeAllConnections()`.
   */
  stop: (force?: boolean) => Promise<void>;
}

/** Rebuild the WHATWG Request node's IncomingMessage arrived as. */
function toRequest(req: http.IncomingMessage, hostHeader: string): Request {
  const url = new URL(req.url ?? "/", `http://${hostHeader}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  // `url.href`, not the URL object: bun-types narrows the Request constructor
  // to string | Request and rejects a URL, which the DOM lib accepts.
  return new Request(url.href, {
    method,
    headers,
    ...(hasBody
      ? {
          body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
          // Node requires this whenever a stream body is supplied.
          duplex: "half",
        }
      : {}),
  } as RequestInit);
}

/** Write a WHATWG Response out through node's ServerResponse. */
async function writeResponse(
  response: Response,
  res: http.ServerResponse,
): Promise<void> {
  for (const [key, value] of response.headers) res.setHeader(key, value);
  res.statusCode = response.status;
  if (!response.body) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Bind a listener and resolve once it is listening.
 *
 * REJECTS on a bind failure -- see the module header. The 'error' listener is
 * attached BEFORE `listen` is called, because node emits EADDRINUSE
 * asynchronously and an unhandled 'error' event on a server crashes the
 * process with a stack trace instead of surfacing the reason.
 */
export function serveFetch(options: ServeFetchOptions): Promise<FetchHttpServer> {
  const hostname = options.hostname;
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const request = toRequest(
          req,
          req.headers.host ?? `${hostname ?? "localhost"}:${options.port}`,
        );
        await writeResponse(await options.fetch(request), res);
      } catch {
        // The handler owns its own error mapping; anything reaching here is a
        // defect in the adapter or an aborted socket. 500 with no body: this
        // surface never logs or echoes content (grading-server.ts header,
        // "LOGGING IS CONTENT-FREE").
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      }
    })();
  });

  return new Promise<FetchHttpServer>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const address = server.address() as AddressInfo | null;
      resolve({
        port: address?.port ?? options.port,
        stop: async (force = true) => {
          if (force) server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (hostname) server.listen(options.port, hostname);
    else server.listen(options.port);
  });
}
