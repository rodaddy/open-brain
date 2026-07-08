type WorkerEnvInput = {
  baseEnv: NodeJS.ProcessEnv;
  port: number;
  poolMax: string;
  runMigrations: boolean;
  workerName: string;
};

export function buildHttpWorkerEnv(input: WorkerEnvInput): NodeJS.ProcessEnv {
  return {
    ...input.baseEnv,
    PORT: String(input.port),
    DB_POOL_MAX: input.poolMax,
    OPEN_BRAIN_RUN_MIGRATIONS: input.runMigrations ? "1" : "0",
    OPEN_BRAIN_WORKER_NAME: input.workerName,
    OPENBRAIN_TRANSPORT: "http",
    OPENBRAIN_NATS_ENABLE_BRIDGE: "false",
  };
}
