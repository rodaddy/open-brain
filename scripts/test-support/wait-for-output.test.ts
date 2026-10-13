import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { waitForOutput, type OutputSource } from "./wait-for-output.ts";

// A stand-in child: an emitter with a stdout stream and the exit fields a
// ChildProcess carries. `out` accumulates stdout the way the spawn site does.
function fakeChild(): {
  child: OutputSource & EventEmitter;
  out: () => string;
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  let out = "";
  stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  return { child, out: () => out, stdout };
}

describe("waitForOutput", () => {
  it("resolves when the marker is already buffered", async () => {
    const { child, out, stdout } = fakeChild();
    const delivered = new Promise((resolve) => stdout.once("data", resolve));
    stdout.write("before READY after\n");
    await delivered;
    expect(out()).toContain("READY");
    await expect(waitForOutput(child, out, "READY")).resolves.toBeUndefined();
  });

  it("resolves when the marker arrives in a later chunk", async () => {
    const { child, out, stdout } = fakeChild();
    const wait = waitForOutput(child, out, "READY");
    stdout.write("REA");
    stdout.write("DY\n");
    await expect(wait).resolves.toBeUndefined();
  });

  it("rejects, naming the marker and exit code, when the child exits first", async () => {
    const { child, out, stdout } = fakeChild();
    const wait = waitForOutput(child, out, "READY");
    stdout.write("no marker here\n");
    child.exitCode = 7;
    child.emit("exit", 7, null);
    await expect(wait).rejects.toThrow(/READY.*exit code 7/);
  });

  it("rejects at once when the child had already exited without the marker", async () => {
    const { child, out } = fakeChild();
    child.exitCode = 3;
    await expect(waitForOutput(child, out, "READY")).rejects.toThrow(
      /READY.*exit code 3/,
    );
  });
});
