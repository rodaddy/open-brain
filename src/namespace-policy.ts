import type { AuthInfo } from "./types.ts";

export interface NamespaceCheck {
  allowed: boolean;
  reason?: string;
}

export function canWriteNamespace(
  auth: AuthInfo,
  targetNamespace: string,
): NamespaceCheck {
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
