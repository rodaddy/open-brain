// Tests for verify-lane's fresh-database teardown (issue 1667).
//
// WHAT THE DEFECT WAS. `verify-lane --fresh-db` runs lane-bootstrap with
// `--fresh-db`, which createdb's a `lane_verify_lane_pr_<n>_...` database, and
// nothing ever dropped it: lane-bootstrap only PRINTS a dropdb line and
// verify-lane's teardown text named only the worktree. Four such databases had
// leaked (PRs 1623, 1624, 1625, 1641) before they were dropped by hand.
//
// No real database is created or dropped here. Every drop goes through an
// injected runner that records the call, so the assertions are on the exact
// command verify-lane WOULD run, never on the cluster.
import { spawnSync } from "node:child_process";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DROPDB_TIMEOUT_MS,
  VERIFY_LANE_DB_PREFIX,
  createFreshDbGuard,
  dropCommand,
  dropFreshDb,
  parseFreshDbName,
  withFreshDbTeardown,
  type DbConnection,
  type DropRunner,
} from "./verify-lane-db.ts";
import { teardownText } from "./verify-lane-support.ts";

const CONN: DbConnection = {
  host: "127.0.0.1",
  port: "5432",
  user: "lane_user",
  password: "pw",
};
const DB = "lane_verify_lane_pr_1667_mx1abc_12345_k2abcd9z";

interface Call {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  timeout: number | undefined;
}

function fakeRunner(status: number | null = 0): { run: DropRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: DropRunner = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env, timeout: opts.timeout });
    return { status, stderr: status === 0 ? "" : "dropdb: error: boom" };
  };
  return { run, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function silence(): { stderr: string[] } {
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stderr };
}

describe("parseFreshDbName", () => {
  it("reads the database name from lane-bootstrap's db-create line", () => {
    const output = [
      "  [ok]   deps: npm ci completed",
      `  [ok]   db-create: ${DB} created (UTF8, template0)`,
      "  [FAIL] db-migrate: npm run migrate exited 1",
    ].join("\n");
    expect(parseFreshDbName(output)).toBe(DB);
  });

  it("returns null when bootstrap created no database", () => {
    expect(parseFreshDbName("  [ok]   deps: npm ci completed\n")).toBeNull();
  });
});

describe("dropFreshDb", () => {
  it("refuses a name without the verify-lane prefix and runs nothing", () => {
    const { stderr } = silence();
    const { run, calls } = fakeRunner();
    expect(
      dropFreshDb({ name: "open_brain_local_20260724", conn: CONN, reason: "t", run }),
    ).toBe("refused");
    expect(calls).toHaveLength(0);
    expect(stderr.join("")).toContain(`lacks the ${VERIFY_LANE_DB_PREFIX} prefix`);
  });

  it("drops a matching name by that exact name, with --if-exists", () => {
    silence();
    const { run, calls } = fakeRunner();
    expect(dropFreshDb({ name: DB, conn: CONN, reason: "t", run })).toBe("dropped");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("dropdb");
    expect(calls[0]?.args).toEqual([
      "--if-exists",
      "--force",
      "--no-password",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      "lane_user",
      DB,
    ]);
    expect(calls[0]?.env?.PGPASSWORD).toBe("pw");
  });

  it("never prompts and cannot hang: --no-password plus a finite spawn timeout", () => {
    silence();
    const { run, calls } = fakeRunner();
    dropFreshDb({ name: DB, conn: CONN, reason: "t", run });
    expect(calls[0]?.args).toContain("--no-password");
    expect(calls[0]?.timeout).toBe(DROPDB_TIMEOUT_MS);
    expect(Number.isFinite(DROPDB_TIMEOUT_MS) && DROPDB_TIMEOUT_MS > 0).toBe(true);
  });

  it("reports a timed-out drop as an orphan, naming the timeout", () => {
    const { stderr } = silence();
    // The shape spawnSync returns when its `timeout` kills the child.
    const timedOut: DropRunner = () => ({
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("spawnSync dropdb ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
    });
    expect(dropFreshDb({ name: DB, conn: CONN, reason: "t", run: timedOut })).toBe(
      "orphaned",
    );
    const text = stderr.join("");
    expect(text).toContain("ORPHANED DATABASE");
    expect(text).toContain(`timed out after ${DROPDB_TIMEOUT_MS} ms`);
    // The printed line is for a human, so it may prompt for a password.
    expect(text).toContain(
      `dropdb --if-exists --force -h 127.0.0.1 -p 5432 -U lane_user ${DB}`,
    );
  });

  it("prints a loud orphan block with the exact dropdb command when the drop fails", () => {
    const { stderr } = silence();
    const { run } = fakeRunner(1);
    expect(dropFreshDb({ name: DB, conn: CONN, reason: "t", run })).toBe("orphaned");
    const text = stderr.join("");
    expect(text).toContain("ORPHANED DATABASE");
    expect(text).toContain(
      `dropdb --if-exists --force -h 127.0.0.1 -p 5432 -U lane_user ${DB}`,
    );
  });
});

describe("withFreshDbTeardown", () => {
  it("drops the adopted database after a successful run", async () => {
    silence();
    const { run, calls } = fakeRunner();
    const guard = createFreshDbGuard(CONN, run);
    const result = await withFreshDbTeardown(guard, () => {
      guard.adopt(DB);
      return Promise.resolve(7);
    });
    expect(result).toBe(7);
    expect(calls.map((c) => c.args.at(-1))).toEqual([DB]);
  });

  it("drops the adopted database when the run throws after creation, and rethrows", async () => {
    silence();
    const { run, calls } = fakeRunner();
    const guard = createFreshDbGuard(CONN, run);
    await expect(
      withFreshDbTeardown(guard, () => {
        guard.adopt(DB);
        return Promise.reject(new Error("run-check exited 1"));
      }),
    ).rejects.toThrow("run-check exited 1");
    expect(calls.map((c) => c.args.at(-1))).toEqual([DB]);
  });

  it("drops nothing when no database was created, and only once when torn down twice", async () => {
    silence();
    const { run, calls } = fakeRunner();
    const empty = createFreshDbGuard(CONN, run);
    await withFreshDbTeardown(empty, () => Promise.resolve(null));
    expect(calls).toHaveLength(0);

    const guard = createFreshDbGuard(CONN, run);
    guard.adopt(DB);
    guard.teardown("exit");
    guard.teardown("SIGINT");
    expect(calls).toHaveLength(1);
  });

  it("refuses to drop an adopted name that lacks the prefix", async () => {
    silence();
    const { run, calls } = fakeRunner();
    const guard = createFreshDbGuard(CONN, run);
    await withFreshDbTeardown(guard, () => {
      guard.adopt("open_brain_local_20260724");
      return Promise.resolve(null);
    });
    expect(calls).toHaveLength(0);
  });
});

describe("teardownText", () => {
  it("names the database's dropdb line when verify-lane created one", () => {
    const drop = `dropdb --if-exists --force -h 127.0.0.1 -p 5432 -U lane_user ${DB}`;
    const text = teardownText("/wt/path", drop);
    expect(text).toContain("git worktree remove /wt/path");
    expect(text).toContain(drop);
  });

  it("is unchanged when no database was created", () => {
    expect(teardownText("/wt/path")).not.toContain("dropdb");
  });
});

describe("dropCommand", () => {
  // Parse the printed command the way a shell would: hand everything after
  // `dropdb` to `printf '%s\n'` under sh and read the argv back one per line.
  function shellArgv(command: string): string[] {
    expect(command.startsWith("dropdb ")).toBe(true);
    const args = command.slice("dropdb ".length);
    const out = spawnSync("sh", ["-c", `printf '%s\\n' ${args}`], {
      encoding: "utf-8",
    });
    expect(out.status).toBe(0);
    return out.stdout.replace(/\n$/, "").split("\n");
  }

  it("shell-quotes a user with a space and a quote so it round-trips to the original argv", () => {
    const user = "o'brien lane";
    const host = "db host";
    const cmd = dropCommand({ ...CONN, user, host }, DB);
    expect(shellArgv(cmd)).toEqual([
      "--if-exists",
      "--force",
      "-h",
      host,
      "-p",
      "5432",
      "-U",
      user,
      DB,
    ]);
  });

  it("prints plain names unchanged", () => {
    expect(dropCommand(CONN, DB)).toBe(
      `dropdb --if-exists --force -h 127.0.0.1 -p 5432 -U lane_user ${DB}`,
    );
    expect(dropCommand(null, DB)).toBe(`dropdb --if-exists --force ${DB}`);
  });
});
