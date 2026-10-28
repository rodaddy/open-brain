import type { LiveEvalConfig } from "./config.ts";
import type { ReflexAbGateClients } from "./reflex-ab-gate.ts";
import { OpenBrainLiveClient, createMcpCaller } from "./transport.ts";
import type { CallerFactory } from "./complete-pack-setup.ts";

// Client lifecycle for the reflex A/B gate.
//
// Identical discipline to the complete-pack gate's setUpCompletePackClients:
// connect the primary and negative callers in order (the negative control is
// mandatory, so BOTH must connect), and if the primary connects but the negative
// connect fails, close the primary before propagating so a live MCP session
// never leaks on a setup failure. The CallerFactory shape is reused from the
// complete-pack setup so both gates share one injectable connect seam.

export type { CallerFactory } from "./complete-pack-setup.ts";

export async function setUpReflexAbClients(
  config: LiveEvalConfig,
  factory: CallerFactory = createMcpCaller,
): Promise<ReflexAbGateClients> {
  const primaryCaller = await factory({
    baseUrl: config.baseUrl,
    token: config.primaryToken,
    namespace: config.primaryNamespace,
    timeoutMs: config.timeoutMs,
  });

  let negativeCaller;
  try {
    negativeCaller = await factory({
      baseUrl: config.baseUrl,
      token: config.negativeToken,
      namespace: config.negativeNamespace,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    // Close the already-connected primary so a negative-connect failure does not
    // strand it. Swallow the close outcome (content-free) so the original connect
    // error is what the caller sees.
    await primaryCaller.close().catch(() => {});
    throw error;
  }

  return {
    primary: new OpenBrainLiveClient(primaryCaller),
    negative: new OpenBrainLiveClient(negativeCaller),
  };
}
