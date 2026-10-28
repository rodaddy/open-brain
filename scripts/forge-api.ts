/**
 * forge-api — the shared Forgejo REST client for this repo's scripts.
 *
 * This repo moved off GitHub on 2026-08-30; `origin` is
 * https://github.com/rodaddy/open-brain.git and `gh` no longer reaches
 * it. Every script that used to shell out to `gh pr view` / `gh pr comment`
 * talks to the Forgejo API through this module instead, so the base URL, the
 * auth header, and the error shape are decided in exactly one place.
 *
 * Auth: `OPEN_BRAIN_FORGE_TOKEN` when set, otherwise the token git already
 * holds for the remote host, read with `git credential fill`. The token is
 * never printed, logged, or included in an error message.
 *
 * This file lives under scripts/, so reading `process.env` here is allowed;
 * server/ code may not. Every exported function takes the environment as a
 * parameter defaulting to `process.env` so tests can inject one.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type ForgeEnv = Record<string, string | undefined>;

export type ForgePull = {
  number: number;
  state: string;
  merged: boolean;
  body: string | null;
  html_url: string;
  head: { sha: string };
};

export type ForgeComment = {
  id: number;
  body: string;
  created_at: string;
};

/** Every failure from this module, so callers can catch one class. */
export class ForgeApiError extends Error {
  readonly detail: string;

  constructor(message: string, detail = "") {
    super(message);
    this.name = "ForgeApiError";
    this.detail = detail;
  }
}

function originUrl(): string {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new ForgeApiError(
      "could not read `git remote get-url origin`; set OPEN_BRAIN_FORGE_API_BASE instead",
      (result.stderr ?? "").trim(),
    );
  }
  return (result.stdout ?? "").trim();
}

/** host, owner and repo parsed out of an https or ssh remote URL. */
function parseRemote(url: string): { host: string; owner: string; repo: string } {
  const cleaned = url.replace(/\.git$/, "");
  const match =
    /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(cleaned) ??
    /^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/](.+?)\/([^/]+)$/.exec(cleaned);
  if (match) {
    const [, host = "", owner = "", repo = ""] = match;
    return { host, owner, repo };
  }
  throw new ForgeApiError(`could not parse the origin remote URL: ${cleaned}`);
}

function remoteHost(env: ForgeEnv): string {
  const base = env.OPEN_BRAIN_FORGE_API_BASE?.trim();
  if (base) {
    try {
      return new URL(base).host;
    } catch {
      throw new ForgeApiError(`OPEN_BRAIN_FORGE_API_BASE is not a URL: ${base}`);
    }
  }
  return parseRemote(originUrl()).host;
}

/**
 * The API root for this repo, with no trailing slash:
 * https://<host>/api/v1/repos/<owner>/<repo>
 */
export function forgeApiBase(env: ForgeEnv = process.env): string {
  const override = env.OPEN_BRAIN_FORGE_API_BASE?.trim();
  if (override) {
    return override.replace(/\/+$/, "");
  }
  const { host, owner, repo } = parseRemote(originUrl());
  return `https://${host}/api/v1/repos/${owner}/${repo}`;
}

/**
 * The API token. Never returned empty: an empty credential throws, naming the
 * host so the operator knows where to log in. The token itself is never in the
 * message.
 */
export function forgeToken(env: ForgeEnv = process.env): string {
  const explicit = env.OPEN_BRAIN_FORGE_TOKEN?.trim();
  if (explicit) {
    return explicit;
  }
  const host = remoteHost(env);
  const result = spawnSync("git", ["credential", "fill"], {
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const password = (result.stdout ?? "")
    .split("\n")
    .find((line) => line.startsWith("password="));
  const token = password ? password.slice("password=".length).trim() : "";
  if (!token) {
    throw new ForgeApiError(
      `no Forgejo token for ${host}: set OPEN_BRAIN_FORGE_TOKEN, or store a credential for that host with git`,
    );
  }
  return token;
}

async function forgeRequest<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  env: ForgeEnv,
): Promise<T> {
  const url = forgeApiBase(env) + path;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `token ${forgeToken(env)}`,
      "Content-Type": "application/json",
    },
  };
  if (method === "POST") {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new ForgeApiError(
      `Forgejo returned ${response.status} for ${method} ${path}`,
      text.slice(0, 2000),
    );
  }
  return (await response.json()) as T;
}

export function forgeGet<T>(path: string, env: ForgeEnv = process.env): Promise<T> {
  return forgeRequest<T>("GET", path, undefined, env);
}

export function forgePost<T>(
  path: string,
  body: unknown,
  env: ForgeEnv = process.env,
): Promise<T> {
  return forgeRequest<T>("POST", path, body, env);
}

/**
 * Every comment on an issue or pull request, walking `?page=N`.
 *
 * Two stop conditions, and the second is not paranoia. Observed live against
 * git.example.internal on 2026-08-29: this endpoint IGNORES `?page=` and returns
 * the same rows for page 1, 2 and 3, so an empty-page-only loop never ends. A
 * page that introduces no comment id we have not already seen therefore also
 * ends the walk, which is correct for a server that pages properly (the page
 * after the last is empty) and for one that does not (page 2 repeats page 1).
 */
export async function forgeListComments(
  issue: string | number,
  env: ForgeEnv = process.env,
): Promise<ForgeComment[]> {
  const all: ForgeComment[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const batch = await forgeGet<ForgeComment[]>(
      `/issues/${issue}/comments?page=${page}`,
      env,
    );
    if (!Array.isArray(batch) || batch.length === 0) {
      return all;
    }
    const fresh = batch.filter((comment) => !seen.has(comment.id));
    if (fresh.length === 0) {
      return all;
    }
    for (const comment of fresh) {
      seen.add(comment.id);
      all.push(comment);
    }
  }
}

/**
 * Walk a paginating Forgejo list endpoint and return every distinct row.
 *
 * The same walk as `forgeListComments`, for any endpoint that returns an array
 * of rows carrying a stable identity. Two stop conditions, and the second is
 * not paranoia: observed live against git.example.internal on 2026-08-29, list
 * endpoints here IGNORE `?page=` and return the same rows for page 1, 2 and 3,
 * so an empty-page-only loop never ends. A page that introduces no identity we
 * have not already seen therefore also ends the walk — correct for a server
 * that pages properly (the page after the last is empty) and for one that does
 * not (page 2 repeats page 1).
 *
 * `path` carries its own query string when it needs one; the page parameter is
 * appended with the right separator.
 */
export async function forgeListPaged<T>(
  path: string,
  identity: (row: T) => number | string,
  env: ForgeEnv = process.env,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<number | string>();
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page += 1) {
    const batch = await forgeGet<T[]>(`${path}${separator}page=${page}`, env);
    if (!Array.isArray(batch) || batch.length === 0) {
      return all;
    }
    const fresh = batch.filter((row) => !seen.has(identity(row)));
    if (fresh.length === 0) {
      return all;
    }
    for (const row of fresh) {
      seen.add(identity(row));
      all.push(row);
    }
  }
}
