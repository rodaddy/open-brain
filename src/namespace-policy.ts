import type { AuthInfo } from "./types.ts";
import {
  sharedNamespaceConfig,
  shouldRejectLegacySharedWrite,
} from "./shared-namespace.ts";

export const PROMOTER_CLIENT_IDS = new Set([
  "openbrain-promoter",
  "hermes-promoter",
]);

export interface NamespaceCheck {
  allowed: boolean;
  reason?: string;
}

export function isPromoterIdentity(auth: AuthInfo): boolean {
  return (
    (auth.role === "admin" || auth.role === "n8n") &&
    PROMOTER_CLIENT_IDS.has(auth.tokenClientId ?? auth.clientId)
  );
}

export function canWriteNamespace(
  auth: AuthInfo,
  targetNamespace: string,
): NamespaceCheck {
  if (shouldRejectLegacySharedWrite(auth, targetNamespace)) {
    return {
      allowed: false,
      reason: `legacy shared namespace '${targetNamespace}' is read-only for normal clients; use '${sharedNamespaceConfig().sharedNamespace}'`,
    };
  }

  if (auth.namespaceSource === "header" && targetNamespace !== auth.clientId) {
    return {
      allowed: false,
      reason: `X-Namespace header requires writes to namespace '${auth.clientId}'`,
    };
  }

  const config = sharedNamespaceConfig();
  if (targetNamespace === config.sharedNamespace && !isPromoterIdentity(auth)) {
    return {
      allowed: false,
      reason:
        `${config.sharedNamespace} writes require the openbrain-promoter or hermes-promoter service identity`,
    };
  }

  if (auth.role === "admin" || auth.role === "n8n") {
    return { allowed: true };
  }

  if (auth.role === "readonly") {
    return { allowed: false, reason: "readonly role cannot write" };
  }

  if (targetNamespace === auth.clientId) {
    return { allowed: true };
  }

  if (auth.role === "discord") {
    return {
      allowed: false,
      reason: `discord role can only write to own namespace (${auth.clientId})`,
    };
  }

  return {
    allowed: false,
    reason: `${auth.role} role cannot write to namespace '${targetNamespace}'`,
  };
}

export function writableNamespaces(auth: AuthInfo): string[] | undefined {
  if (auth.namespaceSource === "header") {
    return [auth.clientId];
  }

  if (auth.role === "admin" || auth.role === "n8n") {
    return undefined;
  }

  return [auth.clientId];
}

export function appendWriteNamespacePredicate(
  auth: AuthInfo,
  params: unknown[],
  column = "namespace",
): string {
  const namespaces = writableNamespaces(auth);
  if (namespaces === undefined) {
    if (
      (auth.role === "admin" || auth.role === "n8n") &&
      !isPromoterIdentity(auth)
    ) {
      params.push(sharedNamespaceConfig().sharedNamespace);
      return ` AND ${column} <> $${params.length}`;
    }
    return "";
  }
  params.push(namespaces);
  return ` AND ${column} = ANY($${params.length}::text[])`;
}
