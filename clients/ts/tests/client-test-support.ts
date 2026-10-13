import { OpenBrainClient, type Transport } from "../src/client.ts";
import { TEST_TOKEN } from "./fakes.ts";

export function makeClient(
  transport: Transport,
  overrides: Partial<ConstructorParameters<typeof OpenBrainClient>[1]> = {},
): OpenBrainClient {
  return new OpenBrainClient("https://brain.example", {
    token: TEST_TOKEN,
    namespace: "bilby",
    transport,
    ...overrides,
  });
}
