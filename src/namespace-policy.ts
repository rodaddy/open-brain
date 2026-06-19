import type { AuthInfo } from "./types.ts";
import {
  physicalNamespace,
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
  // First-class promoter role (#147) is a promoter identity by role alone.
  if (auth.role === "promoter") {
    return true;
  }
  // Backward-compat: the legacy clientId-on-admin/n8n convention (e.g. the
  // in-process legacy-shared promoter CLI) remains a promoter identity.
  return (
    (auth.role === "admin" || auth.role === "n8n") &&
    PROMOTER_CLIENT_IDS.has(auth.tokenClientId ?? auth.clientId)
  );
}

export function canWriteNamespace(
  auth: AuthInfo,
  targetNamespace: string,
): NamespaceCheck {
  const physicalTargetNamespace = physicalNamespace(targetNamespace);
  if (shouldRejectLegacySharedWrite(auth, targetNamespace)) {
    return {
      allowed: false,
      reason: `legacy shared namespace '${targetNamespace}' is read-only for normal clients; use '${sharedNamespaceConfig().canonicalSharedNamespace}'`,
    };
  }

  if (
    auth.namespaceSource === "header" &&
    physicalTargetNamespace !== auth.clientId
  ) {
    return {
      allowed: false,
      reason: `X-Namespace header requires writes to namespace '${auth.clientId}'`,
    };
  }

  const config = sharedNamespaceConfig();
  if (
    physicalTargetNamespace === config.physicalSharedNamespace &&
    !isPromoterIdentity(auth)
  ) {
    return {
      allowed: false,
      reason:
        `${config.sharedNamespace} writes require the openbrain-promoter or hermes-promoter service identity`,
    };
  }

  if (
    auth.role === "admin" ||
    auth.role === "n8n" ||
    auth.role === "promoter"
  ) {
    return { allowed: true };
  }

  if (auth.role === "readonly") {
    return { allowed: false, reason: "readonly role cannot write" };
  }

  if (physicalTargetNamespace === auth.clientId) {
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

  // Promoter writes across namespaces (incl. shared-kb) by design (#147).
  if (
    auth.role === "admin" ||
    auth.role === "n8n" ||
    auth.role === "promoter"
  ) {
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
