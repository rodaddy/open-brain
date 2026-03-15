import { timingSafeEqual } from "node:crypto";
import type { AuthInfo, Role } from "./types.ts";
import { logger } from "./logger.ts";
import type { Request, Response, NextFunction } from "express";

const ROLE_ENV_KEYS: Array<{ envKey: string; role: Role }> = [
  { envKey: "AUTH_TOKEN_ADMIN", role: "admin" },
  { envKey: "AUTH_TOKEN_AGENT", role: "agent" },
  { envKey: "AUTH_TOKEN_DISCORD", role: "discord" },
  { envKey: "AUTH_TOKEN_N8N", role: "n8n" },
  { envKey: "AUTH_TOKEN_READONLY", role: "readonly" },
];

export function buildTokenMap(
  env: Record<string, string | undefined>,
): Map<string, AuthInfo> {
  const map = new Map<string, AuthInfo>();

  for (const { envKey, role } of ROLE_ENV_KEYS) {
    const token = env[envKey];
    if (!token) {
      logger.warn(`Missing auth token for role: ${role}`, { envKey });
      continue;
    }
    map.set(token, { role, clientId: role });
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

    for (const [storedToken, authInfo] of tokenMap) {
      if (verifyToken(provided, storedToken)) {
        (req as any).auth = authInfo;
        next();
        return;
      }
    }

    res.status(401).json({ error: "Invalid token" });
  };
}
