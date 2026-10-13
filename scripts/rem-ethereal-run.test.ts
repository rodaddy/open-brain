import { expect, test, vi } from "vitest";
import type { Pool } from "pg";
import type { RemCandidate } from "../server/maintenance/dream-rem.ts";
import type {
  BackgroundTraceBody,
  BackgroundTraceEmitter,
} from "../server/observability/background-tracing.ts";

let graderTrace: { generation: Function } | undefined;

vi.mock("../server/maintenance/rem-terra-grader.ts", () => ({
  createTerraGrader: (options: { trace?: { generation: Function } }) => {
    graderTrace = options.trace;
    return {
      name: "rem-gpt-5.6-luna-max/round3",
      prime: async () =>
        options.trace?.generation(
          "rem.model.batch",
          async () => [{ id: candidate.id }],
          {
            model: "gpt-5.6-luna",
          },
        ),
      judgementFor: () => ({
        score: 8,
        label: "DECISION",
        quote: "keep this",
        synopsis: "durable decision",
        agent_behavior: "good",
        reasons: ["operator instruction"],
      }),
      grade: async () => ({ grade: "promoted", reason: "fixture" }),
    };
  },
  interactionShape: () => ({ turn_count: 1, operator_chars: 10, agent_chars: 10 }),
}));
vi.mock("../server/maintenance/rem-terra-transport.ts", () => ({
  runTerraBatch: vi.fn(),
}));
vi.mock("../server/config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/config.ts")>()),
  loadServerConfig: () => ({ search: { jevRem: {} } }),
}));

const candidate: RemCandidate = {
  id: "11111111-1111-4111-8111-111111111111",
  namespace: "rico",
  candidate_type: "decision",
  content: "OPERATOR: keep this",
  content_hash: "hash",
  uncertain: false,
  uncertainty_reason: null,
  model: null,
  session_count: 1,
  occurrence_count: 1,
  reinforcement_count: 0,
};

test("persists the requested evaluation route in the manifest", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT nspname")) return { rows: [] };
      return { rows: [] };
    }),
    connect: vi.fn(async function connectStub(this: { query: unknown }) {
      return { query: this.query, release: () => {} };
    }),
  } as unknown as Pool;

  const { gradeDisposable } = await import("./rem-ethereal-run.ts");
  await gradeDisposable({
    pool,
    candidates: [candidate],
    batchSize: 50,
    requested: 1,
    note: "luna comparison",
    model: "gpt-5.6-luna",
    effort: "max",
  });

  const manifest = calls.find((call) =>
    call.sql.includes("INSERT INTO dream_run_001.manifest"),
  );
  expect(manifest?.values?.slice(1, 3)).toEqual(["gpt-5.6-luna", "max"]);
  const judgement = calls.find((call) =>
    call.sql.includes("INSERT INTO dream_run_001.judgement"),
  );
  expect(judgement?.values?.[13]).toBe("rem-gpt-5.6-luna-max/round3");
});

test("emits one correlated root trace around disposable grading", async () => {
  const bodies: BackgroundTraceBody[] = [];
  const emitter: BackgroundTraceEmitter = {
    emitBackground: (body) => bodies.push(body),
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT nspname")) return { rows: [] };
      return { rows: [] };
    }),
    connect: vi.fn(async function connectStub(this: { query: unknown }) {
      return { query: this.query, release: () => {} };
    }),
  } as unknown as Pool;
  const { gradeDisposable } = await import("./rem-ethereal-run.ts");

  await gradeDisposable({
    pool,
    candidates: [candidate],
    batchSize: 50,
    requested: 1,
    note: "trace",
    model: "gpt-5.6-luna",
    effort: "max",
    tracing: emitter,
  });

  expect(graderTrace).toBeDefined();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    name: "dream.rem.ethereal",
    sessionId: "dream_run_001",
    metadata: { run_id: "dream_run_001", model: "gpt-5.6-luna", effort: "max" },
    output: { judged: 1, fell_back: 0, errors: 0 },
    observations: [{ name: "rem.model.batch", type: "generation" }],
  });
});

test("tracing export failure is fail-open for grading", async () => {
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT nspname")) return { rows: [] };
      return { rows: [] };
    }),
    connect: vi.fn(async function connectStub(this: { query: unknown }) {
      return { query: this.query, release: () => {} };
    }),
  } as unknown as Pool;
  const { gradeDisposable } = await import("./rem-ethereal-run.ts");

  await expect(
    gradeDisposable({
      pool,
      candidates: [candidate],
      batchSize: 50,
      requested: 1,
      note: "trace failure",
      model: "gpt-5.6-luna",
      effort: "max",
      tracing: {
        emitBackground: () => {
          throw new Error("export failed");
        },
      },
    }),
  ).resolves.toBeUndefined();
});

test.each([false, true])(
  "CLI shuts tracing down exactly once when list mode failure=%s",
  async (fail) => {
    const shutdown = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const query = vi.fn(async () => {
      if (fail) throw new Error("list failed");
      return { rows: [] };
    });
    const { main } = await import("./rem-ethereal-run.ts");
    const run = main(["--list"], {
      createPool: () => ({ query, end }) as unknown as Pool,
      createTracingRuntime: () => ({
        config: {
          enabled: false,
          maskingEnabled: true,
          endpoint: "",
          publicKey: "",
          secretKey: "",
        },
        shutdown,
      }),
    });

    if (fail) await expect(run).rejects.toThrow("list failed");
    else await expect(run).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  },
);

test("CLI shuts tracing down when pool construction fails", async () => {
  const shutdown = vi.fn(async () => undefined);
  const { main } = await import("./rem-ethereal-run.ts");
  await expect(
    main(["--list"], {
      createPool: () => {
        throw new Error("pool failed");
      },
      createTracingRuntime: () => ({
        config: {
          enabled: false,
          maskingEnabled: true,
          endpoint: "",
          publicKey: "",
          secretKey: "",
        },
        shutdown,
      }),
    }),
  ).rejects.toThrow("pool failed");
  expect(shutdown).toHaveBeenCalledTimes(1);
});

test.each([
  [{}, false],
  [
    {
      OPENBRAIN_TRACING_ENABLED: "1",
      OPENBRAIN_TRACING_ENDPOINT: "https://langfuse.test",
      OPENBRAIN_TRACING_PUBLIC_KEY: "public-test",
      OPENBRAIN_TRACING_SECRET_KEY: "secret-test",
    },
    true,
  ],
] as const)(
  "default CLI tracing composition reads env enabled=%s",
  async (env, enabled) => {
    const configs: boolean[] = [];
    const { main } = await import("./rem-ethereal-run.ts");
    await main(["--list"], {
      env,
      createPool: () =>
        ({
          query: async () => ({ rows: [] }),
          end: async () => undefined,
        }) as unknown as Pool,
      createTracingRuntime: (deps) => {
        if (!deps?.config) throw new Error("expected tracing config");
        configs.push(deps.config.enabled);
        return { config: deps.config, shutdown: async () => undefined };
      },
    });
    expect(configs).toEqual([enabled]);
  },
);
