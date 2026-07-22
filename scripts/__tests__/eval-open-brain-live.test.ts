import { describe, expect, it } from "bun:test";
import { setUpGateClients } from "../eval-open-brain-live.ts";
import type { CallerFactory } from "../eval-open-brain-live.ts";
import { LiveTransportError } from "../../eval/open-brain/live/transport.ts";
import type {
  OpenBrainToolCaller,
  ToolCallResult,
} from "../../eval/open-brain/live/transport.ts";
import type { LiveEvalConfig } from "../../eval/open-brain/live/config.ts";

// Setup-lifecycle unit test for the live gate CLI (issue #322 fix delta). It
// exercises setUpGateClients WITHOUT executing the CLI or touching a hosted
// server, by injecting a fake caller factory. What it pins:
//
//  - When the negative caller's connect fails, the successfully-connected
//    PRIMARY caller is CLOSED before the error propagates -- no live MCP session
//    leaks on a setup failure.
//  - The close is best-effort and content-free: a close that itself throws does
//    not mask or widen the original connect error.
//  - The happy path returns both clients with neither closed.

const CONFIG: LiveEvalConfig = {
  baseUrl: "http://127.0.0.1:3100",
  primaryToken: "primary-token",
  negativeToken: "primary-token",
  negativeTokenIsDistinct: false,
  primaryNamespace: "eval-live-recall-run-test",
  negativeNamespace: "eval-live-recall-run-test-negative",
  searchMode: "hybrid",
  timeoutMs: 1000,
};

interface FakeCaller extends OpenBrainToolCaller {
  namespace: string;
  closes: number;
}

function makeFakeCaller(
  namespace: string,
  opts: { closeThrows?: boolean } = {},
): FakeCaller {
  const caller: FakeCaller = {
    namespace,
    closes: 0,
    async callTool(): Promise<ToolCallResult> {
      return { isError: false, denied: false, data: "{}", errorLabel: "" };
    },
    async close() {
      caller.closes += 1;
      if (opts.closeThrows) {
        throw new Error("close failed 503: leftover private body text");
      }
    },
  };
  return caller;
}

describe("setUpGateClients lifecycle", () => {
  it("closes the connected primary caller when the negative connect fails", async () => {
    const primary = makeFakeCaller(CONFIG.primaryNamespace);
    const connectError = new LiveTransportError("connect:unauthorized", true);
    let primaryConnected = false;

    const factory: CallerFactory = async (o) => {
      if (o.namespace === CONFIG.primaryNamespace) {
        primaryConnected = true;
        return primary;
      }
      // Negative caller connect fails.
      throw connectError;
    };

    await expect(setUpGateClients(CONFIG, factory)).rejects.toBe(connectError);
    // The primary connected, so it must have been closed exactly once.
    expect(primaryConnected).toBe(true);
    expect(primary.closes).toBe(1);
  });

  it("does not mask the original connect error if the primary close itself throws", async () => {
    const primary = makeFakeCaller(CONFIG.primaryNamespace, {
      closeThrows: true,
    });
    const connectError = new LiveTransportError("connect:forbidden", true);

    const factory: CallerFactory = async (o) => {
      if (o.namespace === CONFIG.primaryNamespace) return primary;
      throw connectError;
    };

    // The original connect error is surfaced, not the close error.
    await expect(setUpGateClients(CONFIG, factory)).rejects.toBe(connectError);
    expect(primary.closes).toBe(1);
  });

  it("returns both clients and closes neither on the happy path", async () => {
    const primary = makeFakeCaller(CONFIG.primaryNamespace);
    const negative = makeFakeCaller(CONFIG.negativeNamespace);
    const factory: CallerFactory = async (o) =>
      o.namespace === CONFIG.primaryNamespace ? primary : negative;

    const clients = await setUpGateClients(CONFIG, factory);
    expect(clients.primary).toBeDefined();
    expect(clients.negative).toBeDefined();
    expect(primary.closes).toBe(0);
    expect(negative.closes).toBe(0);
  });

  it("propagates a primary connect failure without constructing a negative caller", async () => {
    const primaryError = new LiveTransportError("connect:http-500", false);
    let negativeAttempted = false;
    const factory: CallerFactory = async (o) => {
      if (o.namespace === CONFIG.primaryNamespace) throw primaryError;
      negativeAttempted = true;
      return makeFakeCaller(CONFIG.negativeNamespace);
    };
    await expect(setUpGateClients(CONFIG, factory)).rejects.toBe(primaryError);
    expect(negativeAttempted).toBe(false);
  });
});
