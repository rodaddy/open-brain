import type { AuthInfo } from "./types.ts";

export function readableNamespaces(auth: AuthInfo): string[] | undefined {
  if (auth.namespaceSource === "header") {
    return [auth.clientId, "collab"];
  }
  if (auth.role === "admin" || auth.role === "n8n") {
    return undefined;
  }
  return [auth.clientId, "collab"];
}

export function canReadNamespace(auth: AuthInfo, namespace: string): boolean {
  if (
    namespace === "all" &&
    auth.namespaceSource === "header" &&
    (auth.role === "admin" || auth.role === "n8n")
  ) {
    return true;
  }
  const allowed = readableNamespaces(auth);
  return !allowed || allowed.includes(namespace);
}

export function namespaceFilterFor(
  auth: AuthInfo,
  namespace?: string,
): string | string[] | undefined {
  if (
    namespace === "all" &&
    auth.namespaceSource === "header" &&
    (auth.role === "admin" || auth.role === "n8n")
  ) {
    return undefined;
  }
  if (namespace !== undefined) {
    return namespace;
  }
  return readableNamespaces(auth);
}
