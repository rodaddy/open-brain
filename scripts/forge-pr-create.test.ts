import { describe, expect, test, vi } from "vitest";

import {
  parseForgePrCreateArgs,
  publishForgePullRequest,
  type ForgePrApi,
} from "./forge-pr-create.ts";

const args = {
  head: "feat/jev-decision-integration",
  base: "main",
  title: "feat: Jev integration",
  body: "first line\n\nsecond line\n",
};

function pull(
  number: number,
  head = args.head,
  base = args.base,
  repo = "rodaddy/open-brain",
) {
  return {
    number,
    html_url: `https://forge.test/pulls/${number}`,
    state: "open",
    draft: false,
    head: { ref: head, sha: `sha-${number}`, repo: { full_name: repo } },
    base: { ref: base, repo: { full_name: "rodaddy/open-brain" } },
  };
}

describe("forge-pr-create", () => {
  test("returns the existing exact-head PR without posting", async () => {
    const existing = pull(77);
    const create = vi.fn();
    const api: ForgePrApi = {
      listOpen: vi.fn(async (path) => {
        expect(path).toBe("/pulls?state=open&limit=50");
        return [existing];
      }),
      create,
    };

    await expect(publishForgePullRequest(args, api)).resolves.toEqual(existing);
    expect(create).not.toHaveBeenCalled();
  });

  test("ignores same-named fork and wrong-base PRs, then creates a real PR", async () => {
    const create = vi.fn(async (_path: string, request: unknown) => ({
      number: 78,
      html_url: "https://forge.test/pulls/78",
      state: "open",
      draft: false,
      head: pull(78).head,
      base: pull(78).base,
      request,
    }));
    const api: ForgePrApi = {
      listOpen: async () => [
        pull(70, args.head, "release"),
        pull(71, args.head, args.base, "someone/fork"),
      ],
      create,
    };

    await publishForgePullRequest(args, api);

    expect(create).toHaveBeenCalledWith("/pulls", {
      head: args.head,
      base: "main",
      title: args.title,
      body: args.body,
    });
  });

  test("recovers an exact PR created concurrently when POST fails", async () => {
    const concurrent = pull(79);
    let reads = 0;
    const api: ForgePrApi = {
      listOpen: async () => (++reads === 1 ? [] : [concurrent]),
      create: async () => {
        throw new Error("conflict");
      },
    };

    await expect(publishForgePullRequest(args, api)).resolves.toEqual(concurrent);
    expect(reads).toBe(2);
  });

  test("rejects protected heads and unknown flags", () => {
    expect(() =>
      parseForgePrCreateArgs([
        "--head",
        "main",
        "--base",
        "main",
        "--title",
        "WIP: unsafe",
        "--body-file",
        "body.md",
      ]),
    ).toThrow("protected head");
    expect(() => parseForgePrCreateArgs(["--repo", "other/repo"])).toThrow(
      "unknown argument",
    );
  });
});
