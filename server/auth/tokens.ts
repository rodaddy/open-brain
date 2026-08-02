/**
 * Bearer-token identity resolution.
 *
 * Design authority: `docs/identity-boundary.md` makes the bearer token the
 * identity boundary; caller-provided client or namespace text is never identity.
 */
import { timingSafeEqual } from "node:crypto";
import type { AuthTokenConfig } from "../config.ts";
import type { AuthIdentity } from "./types.ts";

function sameToken(candidate: string, configured: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(configured);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Resolve an opaque bearer token to its server-configured identity. */
export function resolveBearerToken(
  bearerToken: string,
  configuredTokens: readonly AuthTokenConfig[],
): AuthIdentity | undefined {
  const match = configuredTokens.find((entry) => sameToken(bearerToken, entry.token));
  if (!match) return undefined;
  return {
    role: match.role,
    clientId: match.clientId,
    tokenClientId: match.clientId,
    namespaceSource: "token",
  };
}
