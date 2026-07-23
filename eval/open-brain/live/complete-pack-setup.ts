import type { LiveEvalConfig } from "./config.ts";
import type { CompletePackGateClients } from "./complete-pack-gate.ts";
import type { OpenBrainToolCaller } from "./transport.ts";
import { OpenBrainLiveClient, createMcpCaller } from "./transport.ts";

// Client lifecycle for the complete-pack gate.
//
// Identical discipline to the recall gate's setUpGateClients: connect the
// primary and negative callers in order (the negative control is mandatory, so
// BOTH must connect), and if the primary connects but the negative connect
// fails, close the primary before propagating so a live MCP session never leaks
// on a setup failure. Kept in the eval tree so the complete-pack gate is
// self-contained without importing from the recall gate's CLI script.

/**
 * Factory that connects one MCP caller for a (token, namespace) pair. Injected
 * so the setup lifecycle is unit-testable without a hosted server: a fake factory
 * can simulate a successful primary connect and a failing negative connect,
 * proving the primary is closed and no caller leaks.
 */
export type CallerFactory = (opts: {
  baseUrl: string;
  token: string;
  namespace: string;
  timeoutMs: number;
}) => Promise<OpenBrainToolCaller>;

export async function setUpCompletePackClients(
  config: LiveEvalConfig,
  factory: CallerFactory = createMcpCaller,
): Promise<CompletePackGateClients> {
  const primaryCaller = await factory({
    baseUrl: config.baseUrl,
    token: config.primaryToken,
    namespace: config.primaryNamespace,
    timeoutMs: config.timeoutMs,
  });

  let negativeCaller: OpenBrainToolCaller;
  try {
    negativeCaller = await factory({
      baseUrl: config.baseUrl,
      token: config.negativeToken,
      namespace: config.negativeNamespace,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    // Close the already-connected primary so a negative-connect failure does not
    // strand it. Swallow the close outcome (content-free) so the original
    // connect error is what the caller sees.
    await primaryCaller.close().catch(() => {});
    throw error;
  }

  return {
    primary: new OpenBrainLiveClient(primaryCaller),
    negative: new OpenBrainLiveClient(negativeCaller),
  };
}
