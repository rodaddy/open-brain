/**
 * Hook -- an authenticated webhook receiver.
 *
 * WHY THIS APP IS IN THE EXEMPLAR
 *
 * It is the only one that handles UNTRUSTED INPUT, so it is where the security
 * rules become concrete rather than advisory:
 *
 * - a request body is validated with a schema before anything reads a field
 * - the signature is compared in CONSTANT TIME, because `===` on a secret leaks
 *   it one byte at a time to anyone who can measure
 * - a body size limit is enforced while reading, not after, or the limit is
 *   decoration and the process OOMs first
 * - the secret is never logged, never echoed in an error, never included in a
 *   response
 *
 * Run it: `npm run hook`
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { loadSettings, PROJECT_ROOT, type Settings } from "../../config.ts";
import { createLogger, withLogContext } from "../../utils/logging.ts";
import { requestWithRetry } from "../../utils/http.ts";

/** Maximum body this receiver will read. Enforced DURING the read. */
const MAX_BODY_BYTES = 1_000_000;

/** The payload shape. Anything else is a 400, not a runtime surprise. */
const HookPayload = z.object({
  event: z.string().min(1).max(64),
  /** Free-form, because a webhook body is the sender's shape, not ours. */
  data: z.record(z.unknown()).default({}),
});
export type HookPayload = z.infer<typeof HookPayload>;

/**
 * Compare two signatures without leaking their contents through timing.
 *
 * `a === b` on strings returns as soon as it finds a differing byte, so the
 * time it takes reveals how many leading bytes were correct. That is enough to
 * forge a signature byte by byte. `timingSafeEqual` always compares the whole
 * buffer.
 *
 * @param expected - The signature we computed.
 * @param provided - The signature the caller sent.
 * @returns Whether they match.
 */
export function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // timingSafeEqual THROWS on length mismatch, which would itself leak length
  // through an exception. Check length first and return the same false.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Compute the expected HMAC-SHA256 signature for a body. */
export function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Read a request body, refusing anything over the limit.
 *
 * The limit is enforced as chunks arrive. Checking `content-length` alone is
 * not enough -- it is attacker-controlled and a chunked request may not send
 * one at all.
 *
 * @param req - The incoming request.
 * @returns The body as a string.
 * @throws {Error} When the body exceeds {@link MAX_BODY_BYTES}.
 */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`body exceeds ${String(MAX_BODY_BYTES)} bytes`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/** What the receiver needs. */
export interface HookDeps {
  settings: Settings;
  logger: Logger;
}

/**
 * Whether a request carries a valid signature.
 *
 * Split out of the handler so the handler stays under the `complexity: 10`
 * ceiling, and because "is this request authentic" is a question worth
 * answering on its own -- it can be asserted against a known body and secret
 * with no server, no socket, and no request object beyond a header bag.
 *
 * Returns true when no secret is configured: an unsigned receiver is a
 * deliberate development posture, and `main()` refuses to pair it with
 * forwarding.
 *
 * @param raw - The exact bytes that were signed. Not the parsed object --
 *   re-serializing changes key order and whitespace, and the signature dies.
 * @param provided - The `x-signature` header, whatever arrived.
 * @param secret - The configured signing secret, or null.
 * @returns Whether to proceed.
 */
export function isAuthentic(
  raw: string,
  provided: string | string[] | undefined,
  secret: string | null,
): boolean {
  if (secret === null) return true;
  if (typeof provided !== "string") return false;
  return signaturesMatch(sign(raw, secret), provided);
}

/**
 * Build the receiver.
 *
 * @param deps - Settings and logger.
 * @returns A server ready for `.listen()`.
 */
export function createHookServer(deps: HookDeps): Server {
  const { settings, logger } = deps;

  return createServer((req, res) => {
    void withLogContext(
      { correlationId: `hook-${Date.now().toString(36)}` },
      async (): Promise<void> => {
        const reply = (status: number, body: unknown): void => {
          const payload = JSON.stringify(body);
          res.writeHead(status, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          });
          res.end(payload);
          logger.info({ method: req.method, status }, "hook request");
        };

        if (req.method !== "POST") {
          reply(405, { error: "method not allowed" });
          return;
        }

        let raw: string;
        try {
          raw = await readBody(req);
        } catch (error: unknown) {
          logger.warn(
            { err: error instanceof Error ? error : new Error(String(error)) },
            "body rejected",
          );
          reply(413, { error: "payload too large" });
          return;
        }

        // Signature BEFORE parsing. Parsing an unauthenticated body means
        // spending work -- and exposing a parser -- on input from anyone.
        const provided = req.headers["x-signature"];
        if (!isAuthentic(raw, provided, settings.hook.signingSecret)) {
          // The log records the REJECTION, never the secret and never the
          // expected signature -- either would put the credential in a file.
          logger.warn({ has_signature: provided !== undefined }, "signature rejected");
          reply(401, { error: "invalid signature" });
          return;
        }

        const parsed = HookPayload.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          reply(400, {
            error: "invalid payload",
            // The caller's own field errors are safe to return; they contain
            // nothing we know that they do not.
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          });
          return;
        }

        if (settings.hook.forwardUrl !== null) {
          try {
            await requestWithRetry(settings.hook.forwardUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: raw,
              timeoutMs: 10_000,
              logger,
            });
          } catch (error: unknown) {
            logger.error(
              { err: error instanceof Error ? error : new Error(String(error)) },
              "forward failed",
            );
            reply(502, { error: "forward failed" });
            return;
          }
        }

        reply(202, { accepted: true, event: parsed.data.event });
      },
    );
  });
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const logger = createLogger({
    service: "hook",
    level: settings.logging.level,
    ...(settings.logging.file === null
      ? {}
      : { filePath: join(PROJECT_ROOT, settings.logging.file) }),
    pretty: settings.logging.pretty,
  });

  if (settings.hook.forwardUrl !== null && settings.hook.signingSecret === null) {
    // Refuse to forward unauthenticated traffic: an open relay that forwards
    // anything to an internal service is worse than no receiver at all.
    throw new Error(
      "hook.signingSecret is required when hook.forwardUrl is set. " +
        "ACTION REQUIRED: set EXEMPLAR_HOOK__SIGNING_SECRET or clear the forward URL.",
    );
  }

  const server = createHookServer({ settings, logger });
  server.listen(settings.ports.hook, () => {
    logger.info({ port: settings.ports.hook }, "hook receiver listening");
  });

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      server.close(() => {
        resolve();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

if (process.argv[1]?.endsWith("hook/main.ts") === true) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- the logger may be what failed
    console.error("FATAL:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
