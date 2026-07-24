const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

const REQUIRED_LOCAL_TOKEN_KEYS = [
  "AUTH_TOKEN_ADMIN",
  "AUTH_TOKEN_AGENT",
  "AUTH_TOKEN_DISCORD",
  "AUTH_TOKEN_OB_ADMIN",
  "AUTH_TOKEN_PROMOTER",
  "AUTH_TOKEN_READONLY",
] as const;

import { isAbsolute, relative, resolve, sep } from "node:path";

const PROHIBITED_PATH_KEYS = ["EMBEDDING_WATCHDOG_RESTART_SCRIPT"] as const;

const LOCAL_RUNTIME_PATH_KEYS = [
  "OPENBRAIN_RECOVERY_WAL_PATH",
  "LOG_FILE",
] as const;

export type LocalCloneConfig =
  { enabled: false } | { enabled: true; bindHost: string };

function value(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const configured = env[key]?.trim();
  return configured ? configured : undefined;
}

function requireValue(
  env: Record<string, string | undefined>,
  key: string,
): string {
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

function requirePathInsideRoot(path: string, root: string, key: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`Local clone mode requires ${key} to be an absolute path`);
  }
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const fromRoot = relative(resolvedRoot, resolvedPath);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(
      `Local clone mode requires ${key} beneath OPENBRAIN_LOCAL_CLONE_ROOT`,
    );
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

  const bindHost = requireValue(env, "OPEN_BRAIN_BIND_HOST");
  requireLiteralLoopback(bindHost, "OPEN_BRAIN_BIND_HOST");
  requireLiteralLoopback(requireValue(env, "DB_HOST"), "DB_HOST");

  const embeddingBaseUrl = requireValue(env, "EMBEDDING_BASE_URL");
  let embeddingUrl: URL;
  try {
    embeddingUrl = new URL(embeddingBaseUrl);
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
  const embeddingHost =
    embeddingUrl.hostname === "[::1]" ? "::1" : embeddingUrl.hostname;
  requireLiteralLoopback(embeddingHost, "EMBEDDING_BASE_URL");

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

  const localRoot = requireValue(env, "OPENBRAIN_LOCAL_CLONE_ROOT");
  if (!isAbsolute(localRoot)) {
    throw new Error(
      "Local clone mode requires OPENBRAIN_LOCAL_CLONE_ROOT to be an absolute path",
    );
  }

  if (
    value(env, "OPENBRAIN_TRANSPORT")?.toLowerCase() === "nats" ||
    Object.entries(env).some(
      ([key, configured]) =>
        key.startsWith("OPENBRAIN_NATS_") && Boolean(configured?.trim()),
    )
  ) {
    throw new Error("Local clone mode prohibits NATS configuration");
  }

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
    throw new Error(
      "Local clone mode requires QMD_PATH to be explicitly empty",
    );
  }

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

  return { enabled: true, bindHost };
}
