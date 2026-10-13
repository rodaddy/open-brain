import { expect, test } from "vitest";
import { logger as legacyLogger } from "../logging/legacy-logger.ts";
import {
  installMcpTracing,
  MAX_ACTIVE_SPAN_BYTES,
  traceMcpGeneration,
} from "./langfuse-tracing.ts";
import {
  AUTH,
  consoleTracingLoggerFrom,
  ENABLED_CONFIG,
  fakeServer,
  onlyBody,
  recordingSink,
} from "./langfuse-tracing-fixtures.ts";

const EXPECTED_ACTIVE_OBSERVATION_LIMIT = 128;
const consoleTracingLogger = consoleTracingLoggerFrom(legacyLogger);

test("records bounded generation model, usage, and failures without changing provider behavior", async () => {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const providerFailure = new Error("provider failed");
  let providerCalls = 0;
  server.registerTool(
    "generation_observations",
    { inputSchema: {} } as never,
    (async () => {
      const success = await traceMcpGeneration({
        name: "retrieval.jev.batch",
        input: { state: "api_key=sk-live-generation" },
        model: "jev-configured",
        run: async () => {
          providerCalls++;
          return {
            model: "jev-served",
            usage: { input_tokens: 12, output_tokens: 4 },
            answer: "z".repeat(MAX_ACTIVE_SPAN_BYTES),
          };
        },
        output: ({ answer }) => ({ answer }),
        servedModel: ({ model }) => model,
        usageDetails: ({ usage }) => ({
          input: usage.input_tokens,
          output: usage.output_tokens,
        }),
      });
      let fallback = "unchanged";
      try {
        await traceMcpGeneration({
          name: "retrieval.jev.batch",
          input: { batch: 2, api_key: "test-secret-value" },
          model: "jev-configured",
          run: async () => {
            providerCalls++;
            throw providerFailure;
          },
        });
      } catch (error: unknown) {
        expect(error).toBe(providerFailure);
        fallback = "rrf";
      }
      for (let index = 0; index < 133; index++) {
        await traceMcpGeneration({
          name: "retrieval.jev.batch",
          model: "jev-configured",
          run: async () => {
            providerCalls++;
            return { index };
          },
          output: (result) => result,
        });
      }
      return { completed: success.answer.length > 0, fallback };
    }) as never,
  );
  await handlers.get("generation_observations")?.({}, AUTH);
  const body = onlyBody(sink.bodies);
  expect({
    providerCalls,
    count: body.observations?.length,
    omitted: Number(body.metadata.generation_observations_omitted) > 0,
  }).toEqual({
    providerCalls: 135,
    count: EXPECTED_ACTIVE_OBSERVATION_LIMIT,
    omitted: true,
  });
  expect(
    Buffer.byteLength(JSON.stringify(body.observations), "utf8"),
  ).toBeLessThanOrEqual(MAX_ACTIVE_SPAN_BYTES);
  expect(body.observations?.[0]).toMatchObject({
    name: "retrieval.jev.batch",
    type: "generation",
    model: "jev-served",
    usageDetails: { input: 12, output: 4 },
    level: "DEFAULT",
    metadata: {
      configured_model: "jev-configured",
      payload_degraded: true,
      degradation_reason: "active_observation_bytes_limit",
    },
  });
  expect(body.observations?.[1]).toMatchObject({
    name: "retrieval.jev.batch",
    type: "generation",
    model: "jev-configured",
    level: "ERROR",
    output: { error_class: "Error", error_message: "provider failed" },
  });
  expect([
    JSON.stringify(body.observations).includes("test-secret-value"),
    JSON.stringify(body.observations).includes("[MASKED:"),
  ]).toEqual([false, true]);
});
