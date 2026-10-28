const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

const REQUIRED_LOCAL_TOKEN_KEYS = [
  "AUTH_TOKEN_ADMIN",
  "AUTH_TOKEN_AGENT",
  "AUTH_TOKEN_DISCORD",
  "AUTH_TOKEN_OB_ADMIN",
  "AUTH_TOKEN_PROMOTER",
  "AUTH_TOKEN_READONLY",
] as const;

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const PROHIBITED_PATH_KEYS = ["EMBEDDING_WATCHDOG_RESTART_SCRIPT"] as const;

const LOCAL_RUNTIME_PATH_KEYS = ["OPENBRAIN_RECOVERY_WAL_PATH", "LOG_FILE"] as const;

export type LocalCloneConfig = { enabled: false } | { enabled: true; bindHost: string };

function value(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const configured = env[key]?.trim();
  return configured ? configured : undefined;
}

function requireValue(env: Record<string, string | undefined>, key: string): string {
  const configured = value(env, key);
  if (!configured) {
    throw new Error(`Local clone mode requires ${key}`);
  }
  return configured;
}

function requireLiteralLoopback(host: string, key: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Local clone mode requires ${key} to be a literal loopback address`,
    );
  }
}

function beneathRootError(key: string): Error {
  return new Error(
    `Local clone mode requires ${key} beneath OPENBRAIN_LOCAL_CLONE_ROOT`,
  );
}

function escapesRoot(fromRoot: string): boolean {
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

/**
 * Walk up from `path` to the nearest ancestor that exists on disk, so a not-yet
 * created log or WAL file is still judged against a real canonical parent.
 */
function nearestExistingAncestor(path: string, key: string): string {
  let existingPath = path;
  while (true) {
    try {
      lstatSync(existingPath);
      return existingPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw beneathRootError(key);
      }
      const parent = dirname(existingPath);
      if (parent === existingPath) {
        throw beneathRootError(key);
      }
      existingPath = parent;
    }
  }
}

function canonicalize(path: string, key: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw beneathRootError(key);
  }
}

function requirePathInsideRoot(path: string, root: string, key: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`Local clone mode requires ${key} to be an absolute path`);
  }
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const fromRoot = relative(resolvedRoot, resolvedPath);
  if (fromRoot === "" || escapesRoot(fromRoot)) {
    throw beneathRootError(key);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
  } catch {
    throw new Error("Local clone mode requires OPENBRAIN_LOCAL_CLONE_ROOT to exist");
  }

  const existingPath = nearestExistingAncestor(resolvedPath, key);
  const canonicalExistingPath = canonicalize(existingPath, key);
  if (escapesRoot(relative(canonicalRoot, canonicalExistingPath))) {
    throw beneathRootError(key);
  }
}

function requireBindHost(env: Record<string, string | undefined>): string {
  const bindHost = requireValue(env, "OPEN_BRAIN_BIND_HOST");
  // LAN dogfood opt-in (Dana, 2026-07-31): the bind host alone may open to all
  // interfaces so a second machine can reach this brain; DB, embeddings, and
  // every other clone-mode guard stay loopback-locked.
  if (bindHost !== "0.0.0.0") {
    requireLiteralLoopback(bindHost, "OPEN_BRAIN_BIND_HOST");
  }
  return bindHost;
}

function embeddingHostOf(baseUrl: string): string {
  let embeddingUrl: URL;
  try {
    embeddingUrl = new URL(baseUrl);
  } catch {
    throw new Error(
      "Local clone mode requires EMBEDDING_BASE_URL to be a valid loopback URL",
    );
  }
  if (embeddingUrl.protocol !== "http:" && embeddingUrl.protocol !== "https:") {
    throw new Error(
      "Local clone mode requires EMBEDDING_BASE_URL to be a valid loopback URL",
    );
  }
  return embeddingUrl.hostname === "[::1]" ? "::1" : embeddingUrl.hostname;
}

function requireEmbeddingHost(env: Record<string, string | undefined>): void {
  const embeddingHost = embeddingHostOf(requireValue(env, "EMBEDDING_BASE_URL"));
  // Fleet embedding opt-in (Dana, 2026-08-25, #757): the embedding provider
  // moved off this machine to the fleet AI box, so clone mode accepts ONE
  // explicitly named host alongside loopback. Exact string equality only -- no
  // wildcard, no CIDR, no substring, no name resolution -- and every other
  // clone-mode guard stays loopback-locked, exactly as the bind-host opt-in
  // above does.
  // Read the RAW value, not the trimmed one: surrounding whitespace means the
  // operator wrote something other than a bare hostname, and trimming it away
  // would silently accept a value this guard exists to refuse.
  const allowedEmbeddingHost = env.OPEN_BRAIN_EMBEDDING_HOST_ALLOW;
  if (allowedEmbeddingHost === undefined || allowedEmbeddingHost === "") {
    requireLiteralLoopback(embeddingHost, "EMBEDDING_BASE_URL");
    return;
  }
  if (/[:/\s]/.test(allowedEmbeddingHost)) {
    throw new Error(
      "Local clone mode requires OPEN_BRAIN_EMBEDDING_HOST_ALLOW to be a bare hostname",
    );
  }
  if (!LOOPBACK_HOSTS.has(embeddingHost) && embeddingHost !== allowedEmbeddingHost) {
    throw new Error(
      "Local clone mode requires EMBEDDING_BASE_URL to be a literal loopback address or the OPEN_BRAIN_EMBEDDING_HOST_ALLOW host",
    );
  }
}

function requireDatabaseIdentity(env: Record<string, string | undefined>): void {
  const database = requireValue(env, "DB_NAME");
  if (!database.startsWith("open_brain_local_")) {
    throw new Error(
      "Local clone mode requires DB_NAME to use the open_brain_local_ prefix",
    );
  }

  if (requireValue(env, "DB_USER") !== "open_brain_local_clone") {
    throw new Error("Local clone mode requires DB_USER=open_brain_local_clone");
  }

  if (env.OPEN_BRAIN_RUN_MIGRATIONS !== "0") {
    throw new Error("Local clone mode requires OPEN_BRAIN_RUN_MIGRATIONS=0");
  }
}

function requireNoNats(env: Record<string, string | undefined>): void {
  if (
    value(env, "OPENBRAIN_TRANSPORT")?.toLowerCase() === "nats" ||
    Object.entries(env).some(
      ([key, configured]) =>
        key.startsWith("OPENBRAIN_NATS_") && Boolean(configured?.trim()),
    )
  ) {
    throw new Error("Local clone mode prohibits NATS configuration");
  }
}

function requireLocalPaths(env: Record<string, string | undefined>): void {
  const localRoot = requireValue(env, "OPENBRAIN_LOCAL_CLONE_ROOT");
  if (!isAbsolute(localRoot)) {
    throw new Error(
      "Local clone mode requires OPENBRAIN_LOCAL_CLONE_ROOT to be an absolute path",
    );
  }

  requireNoNats(env);

  for (const key of PROHIBITED_PATH_KEYS) {
    if (value(env, key)) {
      throw new Error(`Local clone mode prohibits ${key}`);
    }
  }

  for (const key of LOCAL_RUNTIME_PATH_KEYS) {
    const configured = value(env, key);
    if (configured) {
      requirePathInsideRoot(configured, localRoot, key);
    }
  }

  // QMD_PATH normally defaults to the production /opt/qmd entrypoint when
  // absent, so clone mode must explicitly suppress that fallback.
  if (env.QMD_PATH !== "") {
    throw new Error("Local clone mode requires QMD_PATH to be explicitly empty");
  }
}

function requireUniqueTokens(env: Record<string, string | undefined>): void {
  const seenTokens = new Set<string>();
  for (const key of REQUIRED_LOCAL_TOKEN_KEYS) {
    const token = requireValue(env, key);
    if (seenTokens.has(token)) {
      throw new Error("Local clone mode requires unique local auth tokens");
    }
    seenTokens.add(token);
  }

  for (const [key, configured] of Object.entries(env)) {
    if (!key.startsWith("AUTH_TOKEN_USER_")) continue;
    const raw = configured?.trim();
    if (!raw) {
      throw new Error(`Local clone mode requires a non-empty value for ${key}`);
    }
    const separator = raw.indexOf(":");
    const token = separator >= 0 ? raw.slice(separator + 1).trim() : "";
    if (!token || seenTokens.has(token)) {
      throw new Error("Local clone mode requires unique local auth tokens");
    }
    seenTokens.add(token);
  }
}

/**
 * Validate the complete fail-closed boundary for a local clone before any
 * database connection or migration can be attempted.
 */
export function validateLocalCloneMode(
  env: Record<string, string | undefined>,
): LocalCloneConfig {
  if (env.OPENBRAIN_LOCAL_CLONE !== "1") {
    return { enabled: false };
  }

  const bindHost = requireBindHost(env);
  requireLiteralLoopback(requireValue(env, "DB_HOST"), "DB_HOST");
  requireEmbeddingHost(env);
  requireDatabaseIdentity(env);
  requireLocalPaths(env);
  requireUniqueTokens(env);

  return { enabled: true, bindHost };
}
