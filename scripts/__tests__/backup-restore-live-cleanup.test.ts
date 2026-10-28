/**
 * Drill cleanup under failure (issue 1667, R2 finding). Fakes only: no
 * database is created, connected, or dropped.
 *
 * A failed run left 10 scratch databases on k3s general: dropScratchDbs
 * stopped at the first failed DROP, closeDrill crashed on the context openDrill
 * never returned, and openDrill left behind what it had already created.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  closeDrill,
  type DrillClient,
  dropScratchDbs,
  openDrill,
  SCRATCH_DBS,
  SRC_DB,
  TGT_DB,
} from "./backup-restore-live-helpers.ts";

interface FakeClient extends DrillClient {
  calls: string[];
  ended: boolean;
}

function fakeClient(failOn: (sql: string) => boolean = () => false): FakeClient {
  const client: FakeClient = {
    calls: [],
    ended: false,
    async query(sql: string) {
      client.calls.push(sql);
      if (failOn(sql)) throw new Error(`fake failure: ${sql}`);
      return { rows: [] };
    },
    async end() {
      client.ended = true;
    },
  };
  return client;
}

const dropOf = (name: string): string => `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dropScratchDbs", () => {
  test("tries every name when one DROP fails, then throws one aggregated error", async () => {
    const client = fakeClient((sql) => sql === dropOf(SRC_DB));
    const failure = await dropScratchDbs(client).then(
      () => null,
      (err: unknown) => err,
    );
    expect(client.calls).toEqual(SCRATCH_DBS.map(dropOf));
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect((failure as AggregateError).message).toContain(SRC_DB);
  });
});

describe("closeDrill", () => {
  test("tolerates the context openDrill never returned", async () => {
    await expect(closeDrill(undefined)).resolves.toBeUndefined();
  });

  test("tolerates a context without an admin client", async () => {
    await expect(closeDrill({ tempDirs: [] })).resolves.toBeUndefined();
  });

  test("still closes the client when a DROP fails, and reports the failure", async () => {
    const client = fakeClient((sql) => sql === dropOf(TGT_DB));
    await expect(closeDrill({ adminClient: client, tempDirs: [] })).rejects.toThrow(
      TGT_DB,
    );
    expect(client.calls).toEqual(SCRATCH_DBS.map(dropOf));
    expect(client.ended).toBe(true);
  });
});

describe("openDrill", () => {
  test("drops what it already created and closes its client when it fails partway", async () => {
    vi.stubEnv(
      "OPENBRAIN_TEST_DATABASE_URL",
      "postgres://fake_admin@127.0.0.1:5432/ob_isolated_fake",
    );
    vi.stubEnv(
      "OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL",
      "postgres://open_brain_local_clone@127.0.0.1:5432/open_brain_local_fake",
    );
    const admin = fakeClient((sql) => sql.startsWith(`CREATE DATABASE ${TGT_DB}`));
    const connect = vi.fn(async () => admin);

    await expect(openDrill(connect)).rejects.toThrow(`CREATE DATABASE ${TGT_DB}`);

    const failedAt = admin.calls.findIndex((sql) =>
      sql.startsWith(`CREATE DATABASE ${TGT_DB}`),
    );
    // SRC_DB was created before the failure, so it is dropped after it; TGT_DB
    // never existed and nothing after it was attempted.
    expect(admin.calls.slice(failedAt + 1)).toEqual([dropOf(SRC_DB)]);
    expect(admin.ended).toBe(true);
  });
});
