import { timingSafeEqual } from "node:crypto";
import type { AuthInfo, Role } from "./types.ts";
import { logger } from "./logger.ts";
import type { Request, Response, NextFunction } from "express";

const VALID_ROLES: Set<string> = new Set<string>([
  "admin",
  "agent",
  "discord",
  "n8n",
  "readonly",
]);

const ROLE_ENV_KEYS: Array<{ envKey: string; role: Role }> = [
  { envKey: "AUTH_TOKEN_ADMIN", role: "admin" },
  { envKey: "AUTH_TOKEN_AGENT", role: "agent" },
  { envKey: "AUTH_TOKEN_DISCORD", role: "discord" },
  { envKey: "AUTH_TOKEN_N8N", role: "n8n" },
  { envKey: "AUTH_TOKEN_READONLY", role: "readonly" },
];

const DELEGATED_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function buildTokenMap(
  env: Record<string, string | undefined>,
): Map<string, AuthInfo> {
  const map = new Map<string, AuthInfo>();

  // Load role-based tokens (AUTH_TOKEN_ADMIN, AUTH_TOKEN_AGENT, etc.)
  for (const { envKey, role } of ROLE_ENV_KEYS) {
    const token = env[envKey];
    if (!token) {
      logger.warn(`Missing auth token for role: ${role}`, { envKey });
      continue;
    }
    map.set(token, { role, clientId: role });
  }

  // Load per-user tokens (AUTH_TOKEN_USER_<NAME>=<role>:<token>)
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("AUTH_TOKEN_USER_") || !value) continue;
    const colonIdx = value.indexOf(":");
    if (colonIdx === -1) {
      logger.warn(`Invalid user token format (expected role:token)`, { key });
      continue;
    }
    const rawRole = value.slice(0, colonIdx);
    if (!VALID_ROLES.has(rawRole)) {
      logger.warn(`Invalid role in user token (skipping)`, {
        key,
        role: rawRole,
      });
      continue;
    }
    const role = rawRole as Role;
    const token = value.slice(colonIdx + 1);
    const userName = key
      .replace("AUTH_TOKEN_USER_", "")
      .toLowerCase()
      .replaceAll("_", "-");
    map.set(token, { role, clientId: userName });
  }

  return map;
}

export function verifyToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  if (a.length !== b.length) {
    // Burn constant time so timing doesn't leak length info
    timingSafeEqual(a, a);
    return false;
  }

  return timingSafeEqual(a, b);
}

export function authMiddleware(
  tokenMap: Map<string, AuthInfo>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing Bearer token" });
      return;
    }

    const provided = authHeader.slice("Bearer ".length);

    // Always iterate ALL tokens to avoid timing side-channel leaking
    // which token (or whether any token) matched early vs late.
    let matched: AuthInfo | null = null;
    for (const [storedToken, authInfo] of tokenMap) {
      if (verifyToken(provided, storedToken)) {
        matched = authInfo;
        // Don't break — iterate all tokens for constant-time
      }
    }

    if (matched) {
      const namespace = headerValue(req.headers["x-namespace"]);
      if (namespace && matched.role !== "admin" && matched.role !== "n8n") {
        res.status(403).json({ error: "Role not permitted to delegate namespace" });
        return;
      }
      const agentId = headerValue(req.headers["x-agent-id"]);
      if (namespace && !DELEGATED_ID_RE.test(namespace)) {
        res.status(400).json({ error: "Invalid X-Namespace header" });
        return;
      }
      if (agentId && !DELEGATED_ID_RE.test(agentId)) {
        res.status(400).json({ error: "Invalid X-Agent-Id header" });
        return;
      }

      (req as any).auth = {
        ...matched,
        clientId: namespace ?? matched.clientId,
        tokenClientId: matched.clientId,
        agentId,
        namespaceSource: namespace ? "header" : "token",
      } satisfies AuthInfo;
      next();
      return;
    }

    res.status(401).json({ error: "Invalid token" });
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return value?.trim() || undefined;
}
