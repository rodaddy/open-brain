import { describe, expect, it, vi } from "vitest";
import { OPEN_BRAIN_ROLES, runEntry, type RoleStarters } from "./entry.ts";

function harness() {
  const starters = {
    server: vi.fn(async (): Promise<void> => undefined),
    "nats-worker": vi.fn(async (): Promise<void> => undefined),
  } satisfies RoleStarters;
  return {
    starters,
    stderr: vi.fn((_line: string): void => undefined),
    exit: vi.fn((_code: number): void => undefined),
  };
}

describe("server/entry.ts role selection (issue 1594)", () => {
  it("starts the server when OPEN_BRAIN_ROLE is unset", async () => {
    const h = harness();
    await runEntry({ env: {}, ...h });
    expect(h.starters.server).toHaveBeenCalledTimes(1);
    expect(h.starters["nats-worker"]).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("starts the server when OPEN_BRAIN_ROLE=server", async () => {
    const h = harness();
    await runEntry({ env: { OPEN_BRAIN_ROLE: "server" }, ...h });
    expect(h.starters.server).toHaveBeenCalledTimes(1);
    expect(h.starters["nats-worker"]).not.toHaveBeenCalled();
  });

  it("starts the NATS worker when OPEN_BRAIN_ROLE=nats-worker", async () => {
    const h = harness();
    await runEntry({ env: { OPEN_BRAIN_ROLE: "nats-worker" }, ...h });
    expect(h.starters["nats-worker"]).toHaveBeenCalledTimes(1);
    expect(h.starters.server).not.toHaveBeenCalled();
  });

  it("refuses an unknown role with exit 2 and a message naming it and the allowed set", async () => {
    const h = harness();
    await runEntry({ env: { OPEN_BRAIN_ROLE: "bogus" }, ...h });
    expect(h.starters.server).not.toHaveBeenCalled();
    expect(h.starters["nats-worker"]).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.stderr).toHaveBeenCalledTimes(1);
    const line = String(h.stderr.mock.calls[0]?.[0]);
    expect(line).toContain('"bogus"');
    for (const role of OPEN_BRAIN_ROLES) expect(line).toContain(role);
  });
});
