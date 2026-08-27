/**
 * The composition root wraps every registered tool handler exactly once.
 *
 * These read the REAL emitted envelope through an in-memory destination, the
 * same way `server/logging/decorate.test.ts` does, rather than asserting
 * against a mock's record of a call. What is under test is the seam in
 * `server/main.ts` — that a handler registered through `registerTool` after
 * `installToolLogging` runs comes back decorated, that its return value is
 * untouched, and that a throw still reaches the caller.
 */
import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import type { DestinationStream } from "pino";
import { createLogger } from "./logging/logger.ts";
import { installToolLogging } from "./main.ts";

const CONFIG = {
  level: "debug" as const,
  file: "logs/open-brain.log",
  service: "open-brain-server",
  workerName: "worker-1",
};

function captureLogger(): {
  logger: ReturnType<typeof createLogger>;
  entries(): Record<string, unknown>[];
} {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return {
    logger: createLogger(CONFIG, stream as DestinationStream),
    entries: () =>
      lines.flatMap((line) =>
        line
          .split("\n")
          .filter(Boolean)
          .map((item) => JSON.parse(item) as Record<string, unknown>),
      ),
  };
}

/**
 * The smallest stand-in that exercises the seam: a `registerTool` that keeps
 * whatever callback it is handed. A real `McpServer` would add a transport,
 * schema validation, and a session, none of which the wrap depends on.
 */
function fakeServer(): {
  server: { registerTool: (...args: unknown[]) => unknown };
  handlerFor(name: string): (...args: never[]) => unknown;
} {
  const registered = new Map<string, (...args: never[]) => unknown>();
  return {
    server: {
      registerTool: (...args: unknown[]) => {
        const [name, , cb] = args;
        if (typeof cb === "function") {
          registered.set(String(name), cb as (...args: never[]) => unknown);
        }
        return undefined;
      },
    },
    handlerFor: (name: string) => {
      const found = registered.get(name);
      if (!found) throw new Error(`no handler registered for ${name}`);
      return found;
    },
  };
}

function install(capture: ReturnType<typeof captureLogger>) {
  const fake = fakeServer();
  installToolLogging(
    fake.server as unknown as Parameters<typeof installToolLogging>[0],
    capture.logger,
  );
  return fake;
}

function messages(entries: Record<string, unknown>[]): string[] {
  return entries.map((entry) => String(entry.message));
}

describe("installToolLogging", () => {
  it("emits entry and exit lines around a registered handler", async () => {
    const capture = captureLogger();
    const fake = install(capture);
    fake.server.registerTool("search_brain", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const result = await (
      fake.handlerFor("search_brain") as () => Promise<unknown>
    )();

    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    const emitted = messages(capture.entries());
    expect(emitted).toContain("operation_entry");
    expect(emitted).toContain("operation_result");
    expect(emitted).not.toContain("operation_failure");
    expect(
      capture
        .entries()
        .every((entry) => entry.operation === "tool.search_brain"),
    ).toBe(true);
  });

  it("emits a failure line with a stack when the handler throws", async () => {
    const capture = captureLogger();
    const fake = install(capture);
    fake.server.registerTool("get_entity", {}, async () => {
      throw new Error("entity lookup exploded");
    });

    await expect(
      (fake.handlerFor("get_entity") as () => Promise<unknown>)(),
    ).rejects.toThrow("entity lookup exploded");

    const failure = capture
      .entries()
      .find((entry) => entry.message === "operation_failure");
    expect(failure).toBeDefined();
    const error = failure?.error as Record<string, unknown> | undefined;
    expect(error?.message).toBe("entity lookup exploded");
    expect(String(error?.stack)).toContain("entity lookup exploded");
    expect(failure?.operation).toBe("tool.get_entity");
    expect(failure).toHaveProperty("correlation_id");
  });

  it("returns an isError result unchanged and records it as an ordinary exit", async () => {
    const capture = captureLogger();
    const fake = install(capture);
    const errorResult = {
      content: [{ type: "text", text: "namespace denied" }],
      isError: true,
    };
    fake.server.registerTool("set_tier", {}, async () => errorResult);

    const result = await (
      fake.handlerFor("set_tier") as () => Promise<unknown>
    )();

    expect(result).toEqual(errorResult);
    const emitted = messages(capture.entries());
    expect(emitted).toContain("operation_result");
    expect(emitted).not.toContain("operation_failure");
  });

  it("passes a non-function third argument straight through", () => {
    const capture = captureLogger();
    const fake = install(capture);
    expect(() =>
      fake.server.registerTool("no_callback", {}, undefined),
    ).not.toThrow();
    expect(capture.entries()).toHaveLength(0);
  });
});
