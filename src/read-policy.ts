import type { AuthInfo } from "./types.ts";
import {
  physicalNamespace,
  sharedNamespaceConfig,
} from "./shared-namespace.ts";

export function readableNamespaces(
  auth: AuthInfo,
  options: { includeLegacySharedFallback?: boolean } = {},
): string[] | undefined {
  const config = sharedNamespaceConfig();
  const sharedNamespaces = [config.physicalSharedNamespace];
  if (options.includeLegacySharedFallback === true) {
    sharedNamespaces.push(config.legacySharedNamespace);
  }
  if (auth.namespaceSource === "header") {
    return [auth.clientId, ...sharedNamespaces];
  }
  // Promoter reads across namespaces to source promotion candidates (#147).
  if (
    auth.role === "admin" ||
    auth.role === "ob-admin" ||
    auth.role === "promoter"
  ) {
    return undefined;
  }
  return [auth.clientId, ...sharedNamespaces];
}

export function canReadNamespace(auth: AuthInfo, namespace: string): boolean {
  const config = sharedNamespaceConfig();
  if (
    namespace === "all" &&
    auth.namespaceSource !== "header" &&
    (auth.role === "admin" || auth.role === "ob-admin")
  ) {
    return true;
  }
  if (
    namespace === config.legacySharedNamespace &&
    auth.role !== "admin" &&
    auth.role !== "ob-admin"
  ) {
    return false;
  }
  const allowed = readableNamespaces(auth);
  return !allowed || allowed.includes(physicalNamespace(namespace));
}

export function namespaceFilterFor(
  auth: AuthInfo,
  namespace?: string,
  options: { includeLegacySharedFallback?: boolean } = {},
): string | string[] | undefined {
  if (
    namespace === "all" &&
    auth.namespaceSource !== "header" &&
    (auth.role === "admin" || auth.role === "ob-admin")
  ) {
    return undefined;
  }
  if (namespace !== undefined) {
    return physicalNamespace(namespace);
  }
  return readableNamespaces(auth, options);
}

export function appendReadNamespacePredicate(
  auth: AuthInfo,
  params: unknown[],
  column = "namespace",
  options: { includeLegacySharedFallback?: boolean } = {},
): string {
  const namespaces = readableNamespaces(auth, options);
  if (namespaces === undefined) {
    return "";
  }
  params.push(namespaces);
  return ` AND ${column} = ANY($${params.length}::text[])`;
}
