/**
 * Shared doubles for the #530 content-ful tracing suites.
 *
 * The suite is split across sibling `langfuse-tracing*.test.ts` files so each
 * one stays a readable unit; every double they share lives here rather than
 * being copied, so a change to the contract lands in one place. No SDK, no
 * server, no socket: the client factory is injected, exactly the seam
 * `McpAuditDeps.now` provides for the audit lane.
 */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
// Type-only, so this stays a compile-time contract and adds no runtime edge
// from the observability tier up into tools (issue 1210). The value of naming
// the caller's own types here is that the double cannot drift from the seam it
// stands in for -- see `qmdSpawn` below.
import type { QmdChild, QmdSpawn } from "../tools/qmd-spawn.ts";
import type { TracedToolRegistrar } from "./trace-types.ts";
import { tracingLoggerFrom } from "./trace-logger-adapter.ts";
import type { TracingLogger } from "./trace-types.ts";
import type { McpTracingConfig, TraceBody, TracingSink } from "./langfuse-tracing.ts";
import { expectDefined } from "../testing/expect-defined.ts";
// The modern engine's row vocabulary (issue 841 cut 2): these fixtures feed the
// modern `mergeFallbackRows` and the modern search registrar, so the row shape
// they build is the modern one. The nine fields below are the ones this factory
// fills, copied structurally from `SearchRow` rather than imported, so the
// observability tier does not reach up into the tools tier (issue 1210).
type FixtureSearchRow = {
  source_type: string;
  id: string;
  namespace: string;
  content_preview: string | null;
  tags: string[] | null;
  created_at: string;
  usefulness: number;
  tier: string;
  distance: number;
  fts_rank: number;
};

/**
 * Wraps the logger the suite hands in, in the fields-first shape the entry
 * points now take. The suite owns which logger it drives -- these fixtures
 * import no production singleton of their own -- and passing the real one
 * keeps the `console`-based capture below seeing the same lines it always did.
 */
export function consoleTracingLoggerFrom(
  legacy: Parameters<typeof tracingLoggerFrom>[0],
): TracingLogger {
  return tracingLoggerFrom(legacy);
}

export const ENABLED_CONFIG: McpTracingConfig = {
  enabled: true,
  maskingEnabled: true,
  endpoint: "http://192.0.2.50:3000",
  publicKey: "pk-lf-test",
  secretKey: "sk-lf-test",
};

export const AUTH = {
  authInfo: {
    role: "admin" as const,
    clientId: "rico",
    tokenClientId: "rico",
    agentId: "worker-530",
    namespaceSource: "header" as const,
  },
};

interface RecordedLine {
  level: string;
  fields: Record<string, unknown>;
  message: string;
}

/** A two-method recorder standing in for the composition root logger. */
export function recordingLogger(): TracingLogger & {
  readonly lines: RecordedLine[];
} {
  const lines: RecordedLine[] = [];
  return {
    lines,
    info: (fields, message) => {
      lines.push({ level: "info", fields, message });
    },
    warn: (fields, message) => {
      lines.push({ level: "warn", fields, message });
    },
  };
}

/** A minimal stand-in for the SDK sink that records what it was handed. */
export function recordingSink(): TracingSink & { bodies: TraceBody[] } {
  const bodies: TraceBody[] = [];
  return {
    bodies,
    emit(body) {
      bodies.push(body);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

/**
 * A sink whose drain NEVER settles — the real adversary for shutdown.
 *
 * This is what an unreachable endpoint produces: a promise that stays pending
 * far past any supervisor's patience (the v3 lane was measured at 28.0 s,
 * against launchd's 20 s `ExitTimeOut`). `throwingSink` cannot stand in for it,
 * because rejecting instantly is the one thing a hung socket does not do — and
 * no SDK timeout setting can be trusted to cover this, which is why the drain
 * is raced rather than merely configured.
 */
export function hangingSink(): TracingSink {
  return {
    emit: () => undefined,
    forceFlush: () => new Promise<void>(() => {}),
    shutdown: () => new Promise<void>(() => {}),
  };
}

/** A sink that fails on every method — the best-effort contract's adversary. */
export function throwingSink(): TracingSink {
  return {
    emit() {
      throw new Error("langfuse exploded with secret sk-lf-leak in the message");
    },
    forceFlush: () => Promise.reject(new Error("flush exploded")),
    shutdown: () => Promise.reject(new Error("shutdown exploded")),
  };
}

/**
 * A sink that fails only while `down` is true — the outage simulator.
 *
 * The #530 alert contract is about TRANSITIONS, so the adversary has to be able
 * to change state mid-run. A sink that always fails can only ever prove the
 * suspend line; it can never prove that recovery reports the right drop count,
 * or that the healthy path stays silent.
 */
export function flakySink(): TracingSink & { down: boolean; bodies: TraceBody[] } {
  const bodies: TraceBody[] = [];
  return {
    down: false,
    bodies,
    emit(body) {
      if (this.down) throw new Error("connect ECONNREFUSED sk-lf-leak");
      bodies.push(body);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

interface FakeServer {
  server: TracedToolRegistrar;
  handlers: Map<string, (args: unknown, extra: unknown) => unknown>;
  originalRegisterTool: unknown;
}

/**
 * A fake tool registrar exposing only `registerTool`, plus the handler capture the
 * assertions need. Structural, because the real class needs a transport.
 */
export function fakeServer(): FakeServer {
  const handlers = new Map<string, (args: unknown, extra: unknown) => unknown>();
  const registerTool = (name: string, _config: unknown, cb: unknown): void => {
    handlers.set(name, cb as (args: unknown, extra: unknown) => unknown);
  };
  const server = { registerTool } as unknown as TracedToolRegistrar;
  return { server, handlers, originalRegisterTool: registerTool };
}

export function searchRow(id: string, content = `content ${id}`): FixtureSearchRow {
  return {
    source_type: "thought",
    id,
    namespace: "rico",
    content_preview: content,
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    usefulness: 0.5,
    tier: "warm",
    distance: 0.1,
    fts_rank: 0.5,
  };
}

/**
 * A qmd-spawn double returning one JSON document list on stdout.
 *
 * Typed against `QmdSpawn` -- the seam `search-all.ts` actually calls -- and
 * NOT against the Bun spawn signature it stood in for before issue 751. That
 * distinction is the whole value of the double: a double pinned to a signature
 * its caller no longer uses still compiles, and silently stops exercising the
 * real path. Because the type now follows the caller, a future change to the
 * seam breaks this file loudly instead.
 *
 * The child is a `Readable` pair plus a 'close' emitter, because the seam
 * drains streams and waits on an EVENT rather than reading an `.exited`
 * promise. `kill` is present so the timeout path has something honest to call
 * (its absence is the `TypeError: proc.kill is not a function` of #632).
 */
export function qmdSpawn(docs: unknown[]): QmdSpawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & QmdChild;
    child.stdout = Readable.from([JSON.stringify(docs)]);
    child.stderr = Readable.from([]);
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    // Emitted after the current turn so a listener attached by the race is
    // already in place, matching a real child's ordering.
    setImmediate(() => child.emit("close", 0, null));
    return child;
  }) as QmdSpawn;
}

/** The single trace a one-call case produces, narrowed for the assertions. */
export function onlyBody(bodies: TraceBody[]): TraceBody {
  return expectDefined(bodies[0], "the first recorded trace body");
}

/** The child spans of the single trace a one-call case produces. */
export function onlySpans(bodies: TraceBody[]): NonNullable<TraceBody["spans"]> {
  return expectDefined(onlyBody(bodies).spans, "the trace child spans");
}

/** The masked `content_preview` the retrieval-evidence cases assert on. */
export function firstCandidatePreview(bodies: TraceBody[]): string {
  const output = expectDefined(onlySpans(bodies)[0], "the first child span").output as {
    candidates: Array<{ content_preview: string }>;
  };
  return expectDefined(output.candidates[0], "the first retrieval candidate")
    .content_preview;
}
