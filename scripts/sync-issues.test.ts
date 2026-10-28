import { describe, expect, it } from "vitest";
import { redactRetiredHost, render, slug } from "./sync-issues.ts";

// The retired host's name and address are built from parts so this file does
// not itself carry them (operator ruling 2026-10-04, issue 1678).
const HOST = "oldhost" + "01";
const IP = "10.0.1." + "21";

const issue = {
  number: 9999,
  title: `Move the ${HOST.toUpperCase()} deploy off ${IP}`,
  state: "OPEN",
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  closedAt: null,
  author: { login: "rodaddy" },
  labels: [],
  milestone: null,
  body: `The ${HOST}-deploy-local script ran on ${IP}:3100 (${HOST.charAt(0).toUpperCase()}${HOST.slice(1)}).`,
  comments: [
    {
      author: { login: "rodaddy" },
      createdAt: "2026-10-04T01:00:00Z",
      body: `still on ${HOST}`,
    },
  ],
};

describe("redactRetiredHost", () => {
  it("replaces the host name in any case and its old address", () => {
    expect(redactRetiredHost(`${HOST} ${HOST.toUpperCase()} ${IP}:3100`)).toBe(
      "retired-host retired-host retired-host-ip:3100",
    );
  });

  it("leaves unrelated words and other addresses untouched", () => {
    const text = "oldhost02 myoldhost 01 oldhost0 10.0.1.20 10.0.1.210";
    expect(redactRetiredHost(text)).toBe(text);
  });
});

describe("the mirror generator", () => {
  it("renders title, body and discussion redacted", () => {
    const out = render(issue);
    expect(out.toLowerCase()).not.toContain(HOST);
    expect(out).not.toContain(IP);
    expect(out).toContain("# #9999 — Move the retired-host deploy off retired-host-ip");
    expect(out).toContain(
      "The retired-host-deploy-local script ran on retired-host-ip:3100 (retired-host).",
    );
    expect(out).toContain("still on retired-host");
  });

  it("builds the file slug from the redacted title", () => {
    expect(slug(issue.title)).toBe("move-the-retired-host-deploy-off-retired-host-ip");
  });

  it("slugs a title without the host exactly as before", () => {
    expect(slug("Encore: core02 hardening")).toBe("encore-core02-hardening");
  });
});
