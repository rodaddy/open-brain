import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildChildEnvironment,
  describeDroppedChildEnvironment,
  LOCAL_CLONE_VERIFY_RECEIPT_SCHEMA,
  productionDependencies,
  runLocalCloneLauncher,
  SERVING_ENTRYPOINT,
  type LocalCloneLauncherDependencies,
} from "./local-clone.ts";

function cloneEnv(): Record<string, string | undefined> {
  return {
    OPENBRAIN_LOCAL_CLONE: "1",
    OPENBRAIN_LOCAL_CLONE_ROOT: "/safe/local-clone",
    OPEN_BRAIN_BIND_HOST: "127.0.0.1",
    OPEN_BRAIN_RUN_MIGRATIONS: "0",
    DB_HOST: "127.0.0.1",
    DB_PORT: "55432",
    DB_NAME: "open_brain_local_dogfood",
    DB_USER: "open_brain_local_clone",
    DB_PASSWORD: "local-secret",
    EMBEDDING_BASE_URL: "http://127.0.0.1:8791/v1",
    EMBEDDING_MODEL: "local-model",
    EMBEDDING_DIMENSIONS: "768",
    QMD_PATH: "",
    AUTH_TOKEN_ADMIN: "local-admin",
    AUTH_TOKEN_AGENT: "local-agent",
    AUTH_TOKEN_DISCORD: "local-discord",
    AUTH_TOKEN_OB_ADMIN: "local-ob-admin",
    AUTH_TOKEN_PROMOTER: "local-promoter",
    AUTH_TOKEN_READONLY: "local-readonly",
  };
}

function childProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  return child;
}

function fakeDependencies(
  overrides: Partial<LocalCloneLauncherDependencies> = {},
): LocalCloneLauncherDependencies {
  return {
    database: {
      prove: async () => ({
        database: "open_brain_local_dogfood",
        user: "open_brain_local_clone",
        serverAddress: "127.0.0.1",
        serverPort: 55432,
        postgresMajor: 18,
        transactionReadOnly: true,
        pgvectorAvailable: true,
        pgvectorInstalled: true,
      }),
    },
    embedding: {
      prove: async () => ({ model: "local-model", dimensions: 768 }),
    },
    child: { spawn: () => childProcess() },
    writeReceipt: () => undefined,
    onSignal: () => () => undefined,
    announce: () => undefined,
    ...overrides,
  };
}

describe("local clone launcher", () => {
  it("emits one content-free receipt after both compatibility proofs", async () => {
    const calls: string[] = [];
    const receipts: unknown[] = [];
    const deps = fakeDependencies({
      database: {
        prove: async () => {
          calls.push("database");
          return {
            database: "open_brain_local_dogfood",
            user: "open_brain_local_clone",
            serverAddress: "127.0.0.1",
            serverPort: 55432,
            postgresMajor: 18,
            transactionReadOnly: true,
            pgvectorAvailable: true,
            pgvectorInstalled: true,
          };
        },
      },
      embedding: {
        prove: async () => {
          calls.push("embedding");
          return { model: "local-model", dimensions: 768 };
        },
      },
      writeReceipt: (receipt) => receipts.push(receipt),
    });

    expect(await runLocalCloneLauncher("verify", cloneEnv(), deps)).toBe(0);
    expect(calls).toEqual(["database", "embedding"]);
    expect(receipts).toEqual([
      {
        schema: LOCAL_CLONE_VERIFY_RECEIPT_SCHEMA,
        operation: "local_clone_verify",
        status: "verified",
        database: {
          identity_verified: true,
          read_only: true,
          postgres_major: 18,
          pgvector_available: true,
          pgvector_installed: true,
        },
        embedding: {
          model_verified: true,
          dimensions: 768,
          healthy: true,
        },
      },
    ]);
    expect(JSON.stringify(receipts)).not.toContain("local-secret");
  });

  it("fails closed before embedding or spawn when database identity differs", async () => {
    let embeddingCalled = false;
    let spawnCalled = false;
    const deps = fakeDependencies({
      database: {
        prove: async () => ({
          database: "open_brain",
          user: "open_brain_local_clone",
          serverAddress: "127.0.0.1",
          serverPort: 55432,
          postgresMajor: 18,
          transactionReadOnly: true,
          pgvectorAvailable: true,
          pgvectorInstalled: true,
        }),
      },
      embedding: {
        prove: async () => {
          embeddingCalled = true;
          return { model: "local-model", dimensions: 768 };
        },
      },
      child: {
        spawn: () => {
          spawnCalled = true;
          return childProcess();
        },
      },
    });

    await expect(
      runLocalCloneLauncher("start", cloneEnv(), deps),
    ).rejects.toThrow("identity does not match DB_NAME");
    expect(embeddingCalled).toBe(false);
    expect(spawnCalled).toBe(false);
  });

  it("fails closed on PostgreSQL, pgvector, and embedding incompatibility", async () => {
    for (const database of [
      { postgresMajor: 17 },
      { pgvectorAvailable: false },
      { pgvectorInstalled: false },
      { transactionReadOnly: false },
    ]) {
      const base = await fakeDependencies().database.prove(cloneEnv());
      await expect(
        runLocalCloneLauncher(
          "verify",
          cloneEnv(),
          fakeDependencies({
            database: { prove: async () => ({ ...base, ...database }) },
          }),
        ),
      ).rejects.toThrow();
    }

    await expect(
      runLocalCloneLauncher(
        "verify",
        cloneEnv(),
        fakeDependencies({
          embedding: {
            prove: async () => ({ model: "local-model", dimensions: 384 }),
          },
        }),
      ),
    ).rejects.toThrow("incompatible dimension");
  });

  it("spawns only after proofs with an allowlisted environment and forwards signals", async () => {
    const child = childProcess();
    const killed: NodeJS.Signals[] = [];
    child.kill = ((signal?: NodeJS.Signals | number) => {
      if (typeof signal === "string") {
        killed.push(signal);
        queueMicrotask(() => child.emit("exit", 0, null));
      }
      return true;
    }) as ChildProcess["kill"];
    const handlers = new Map<NodeJS.Signals, () => void>();
    let signalHandlersReady!: () => void;
    const signalsReady = new Promise<void>((resolve) => {
      signalHandlersReady = resolve;
    });
    let spawnedEnv: Record<string, string> | undefined;
    const env = {
      ...cloneEnv(),
      PATH: "/should/not/be/inherited",
      SSH_AUTH_SOCK: "/should/not/be/inherited",
      CORE01_HOST: "192.0.2.21",
      AUTH_TOKEN_USER_LOCAL: "rico:local-user-token",
      OPENBRAIN_TRACING_ENABLED: "1",
      OPENBRAIN_TRACING_ENDPOINT: "http://langfuse.local:3000",
    };
    const deps = fakeDependencies({
      child: {
        spawn: (childEnv) => {
          spawnedEnv = childEnv;
          return child;
        },
      },
      onSignal: (signal, handler) => {
        handlers.set(signal, handler);
        if (handlers.size === 2) signalHandlersReady();
        return () => handlers.delete(signal);
      },
    });

    const result = runLocalCloneLauncher("start", env, deps);
    await signalsReady;
    handlers.get("SIGTERM")?.();
    expect(await result).toBe(0);
    expect(killed).toEqual(["SIGTERM"]);
    expect(spawnedEnv).toEqual(buildChildEnvironment(env));
    expect(spawnedEnv?.DB_PASSWORD).toBe("local-secret");
    expect(spawnedEnv?.AUTH_TOKEN_USER_LOCAL).toBe("rico:local-user-token");
    // #530: the tracing coordinates must reach the server child, or
    // createTracingRuntime silently stays off while the env file says on.
    expect(spawnedEnv?.OPENBRAIN_TRACING_ENABLED).toBe("1");
    expect(spawnedEnv?.OPENBRAIN_TRACING_ENDPOINT).toBe(
      "http://langfuse.local:3000",
    );
    expect(spawnedEnv).not.toHaveProperty("PATH");
    expect(spawnedEnv).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(spawnedEnv).not.toHaveProperty("CORE01_HOST");
    expect(handlers.size).toBe(0);
  });

  // #659: the capture-health observer merged in #656 builds nothing unless
  // these reach the server child. The clone was redeployed with a PASSING
  // revision proof and live /health still published no capture block, because
  // the launcher dropped the configured namespace in silence.
  it("passes the capture-health observer configuration to the server child", () => {
    const child = buildChildEnvironment({
      ...cloneEnv(),
      OPENBRAIN_CAPTURE_HEALTH_NAMESPACE: "rico",
      OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES: "360",
      OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS: "60000",
    });
    expect(child.OPENBRAIN_CAPTURE_HEALTH_NAMESPACE).toBe("rico");
    expect(child.OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES).toBe("360");
    expect(child.OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS).toBe("60000");
  });

  it("names a configured server-config key it drops, without echoing its value", () => {
    const dropped = describeDroppedChildEnvironment({
      ...cloneEnv(),
      OPENBRAIN_SOME_FUTURE_SERVER_KEY: "super-secret-value",
    });
    expect(dropped.map((entry) => entry.key)).toContain(
      "OPENBRAIN_SOME_FUTURE_SERVER_KEY",
    );
    expect(JSON.stringify(dropped)).not.toContain("super-secret-value");
  });

  it("does not report ambient host variables as dropped configuration", () => {
    // The autostart wrapper sources the env file with `set -a`, so the
    // launcher's environment is the env file UNIONED with launchd's. A report
    // naming PATH and HOME on every boot is noise an operator learns to skip,
    // which is silence with extra steps.
    const dropped = describeDroppedChildEnvironment({
      ...cloneEnv(),
      PATH: "/usr/bin:/bin",
      HOME: "/Users/placeholder",
      SSH_AUTH_SOCK: "/placeholder/agent.sock",
    }).map((entry) => entry.key);
    expect(dropped).not.toContain("PATH");
    expect(dropped).not.toContain("HOME");
    expect(dropped).not.toContain("SSH_AUTH_SOCK");
  });

  it("reporting a dropped key does not deliver it — the allowlist stays an allowlist", () => {
    const env = {
      ...cloneEnv(),
      OPENBRAIN_SOME_FUTURE_SERVER_KEY: "configured-but-unlisted",
    };
    expect(
      describeDroppedChildEnvironment(env).map((entry) => entry.key),
    ).toContain("OPENBRAIN_SOME_FUTURE_SERVER_KEY");
    expect(buildChildEnvironment(env)).not.toHaveProperty(
      "OPENBRAIN_SOME_FUTURE_SERVER_KEY",
    );
  });

  it("announces the dropped keys on the start path before spawning", async () => {
    const child = childProcess();
    const announced: string[] = [];
    const deps = fakeDependencies({
      child: {
        spawn: () => {
          queueMicrotask(() => child.emit("exit", 0, null));
          return child;
        },
      },
      announce: (line) => announced.push(line),
    });

    const code = await runLocalCloneLauncher(
      "start",
      { ...cloneEnv(), OPENBRAIN_SOME_FUTURE_SERVER_KEY: "unlisted" },
      deps,
    );

    expect(code).toBe(0);
    expect(announced.join("\n")).toContain("OPENBRAIN_SOME_FUTURE_SERVER_KEY");
  });

  it("stays quiet when every configured server-config key is delivered", () => {
    // The healthy path must not emit the notice, or the line is decoration an
    // operator cannot use to tell a broken deploy from a normal one.
    expect(describeDroppedChildEnvironment(cloneEnv())).toEqual([]);
  });

  it("rejects an environment that is not explicitly local-clone mode", async () => {
    const env = cloneEnv();
    delete env.OPENBRAIN_LOCAL_CLONE;
    await expect(
      runLocalCloneLauncher("verify", env, fakeDependencies()),
    ).rejects.toThrow("OPENBRAIN_LOCAL_CLONE=1");
  });

  it("redacts arbitrary external-boundary failures", async () => {
    await expect(
      runLocalCloneLauncher(
        "verify",
        cloneEnv(),
        fakeDependencies({
          database: {
            prove: async () => {
              throw new Error(
                "password=should-not-escape host=external.example",
              );
            },
          },
        }),
      ),
    ).rejects.toThrow("Local clone database preflight failed");
  });

  /**
   * The cutover, asserted at the only site that decides it.
   *
   * Charter §4 Phase 6 (`_plans/463-server-rewrite-charter.md`) flips the local
   * dogfood serving target from `src/index.ts` to the rewrite's entrypoint. The
   * target used to be a string literal inside `productionDependencies.child`,
   * reachable only by starting a real process -- so nothing could assert it and
   * a silent revert would have been caught only by a deploy. These two tests are
   * the tripwire: what we intend to start, and that the file is really there.
   */
  it("names the rewrite entrypoint as the local dogfood serving target", () => {
    expect(SERVING_ENTRYPOINT).toBe("server/main.ts");
  });

  it("points the serving target at a file that exists in this tree", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    expect(existsSync(`${repoRoot}${SERVING_ENTRYPOINT}`)).toBe(true);
  });
});

const REAL_PG_URL = process.env.OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL;

describe.skipIf(!REAL_PG_URL)(
  "local clone real PostgreSQL boundary (live Postgres)",
  () => {
    it("proves the explicit loopback clone in a read-only transaction", async () => {
      const url = new URL(REAL_PG_URL!);
      const host = url.hostname === "[::1]" ? "::1" : url.hostname;
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        throw new Error(
          "OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL must be a PostgreSQL URL",
        );
      }
      if (host !== "127.0.0.1" && host !== "::1") {
        throw new Error(
          "OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL must use literal loopback",
        );
      }
      const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const user = decodeURIComponent(url.username);
      if (!database.startsWith("open_brain_local_")) {
        throw new Error(
          "OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL must name a local clone",
        );
      }
      if (user !== "open_brain_local_clone") {
        throw new Error(
          "OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL must use the clone role",
        );
      }

      const proof = await productionDependencies.database.prove({
        DB_HOST: host,
        DB_PORT: url.port || "5432",
        DB_NAME: database,
        DB_USER: user,
        DB_PASSWORD: decodeURIComponent(url.password),
      });

      expect(proof).toMatchObject({
        database,
        user,
        serverAddress: host,
        serverPort: Number.parseInt(url.port || "5432", 10),
        postgresMajor: 18,
        transactionReadOnly: true,
        pgvectorAvailable: true,
        pgvectorInstalled: true,
      });
    });
  },
);
