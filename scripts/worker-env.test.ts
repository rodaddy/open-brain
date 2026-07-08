import { describe, expect, it } from "bun:test";
import { buildHttpWorkerEnv } from "./worker-env.ts";

describe("buildHttpWorkerEnv", () => {
  it("forces HTTP workers to stay off the NATS bridge even when shared env opts into NATS", () => {
    const env = buildHttpWorkerEnv({
      baseEnv: {
        OPENBRAIN_TRANSPORT: "nats",
        OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
        OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
      },
      port: 3101,
      poolMax: "5",
      runMigrations: true,
      workerName: "open-brain-worker-1",
    });

    expect(env).toMatchObject({
      PORT: "3101",
      DB_POOL_MAX: "5",
      OPEN_BRAIN_RUN_MIGRATIONS: "1",
      OPEN_BRAIN_WORKER_NAME: "open-brain-worker-1",
      OPENBRAIN_TRANSPORT: "http",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "false",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });
  });
});
