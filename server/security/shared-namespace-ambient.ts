/**
 * The zero-argument shared-namespace call form, served from `server/config.ts`.
 *
 * Design authority: Rico ruling 2026-08-30 — the environment reads the retired
 * L5 adapters were doing "should all be done from a config.ts, much like we use
 * config.py in Python applications". `server/config.ts` is the one module
 * allowed to read `process.env`, so it owns the read
 * (`sharedNamespaceEnvironment`) and this module is the thin call-form bridge
 * that lets the existing deep call chains keep their argument shape.
 *
 * WHY A BRIDGE AND NOT A THREADED PARAMETER. The name-set is consulted deep
 * inside request handling — namespace policy, read policy, promotion, repo
 * facts, legacy search, graph derivation — by functions whose signatures are a
 * public contract of their own. Threading a parameter through all of them is a
 * redesign; this rung is a relocation. The resolution itself still has exactly
 * one implementation, in `./shared-namespace.ts`, and is not duplicated here.
 *
 * SECURITY. Namespace resolution is an isolation boundary
 * (`docs/sme/security.md`). Nothing here decides anything: every function below
 * forwards the same eight raw values to the same resolver the retired
 * pre-move adapter forwarded them to, so predicates, defaults and precedence
 * are unchanged.
 */
import { sharedNamespaceEnvironment } from "../config.ts";
import type { AuthInfo } from "../types.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";
import {
  canonicalNamespace as canonicalNamespaceWith,
  isLegacySharedNamespace as isLegacySharedNamespaceWith,
  isSharedNamespace as isSharedNamespaceWith,
  physicalNamespace as physicalNamespaceWith,
  sharedNamespaceConfig as sharedNamespaceConfigWith,
  shouldRejectLegacySharedWrite as shouldRejectLegacySharedWriteWith,
} from "./shared-namespace.ts";

export type { SharedNamespaceConfig };

/** The resolved name set for the current configuration. */
export function sharedNamespaceConfig(): SharedNamespaceConfig {
  return sharedNamespaceConfigWith(sharedNamespaceEnvironment());
}

/** True when `namespace` is either name of the shared partition. */
export function isSharedNamespace(namespace: string): boolean {
  return isSharedNamespaceWith(namespace, sharedNamespaceEnvironment());
}

/** True only when a non-empty legacy shared namespace is configured and matches. */
export function isLegacySharedNamespace(namespace: string): boolean {
  return isLegacySharedNamespaceWith(namespace, sharedNamespaceEnvironment());
}

/** Translate a physical or legacy name to the canonical one. */
export function canonicalNamespace(namespace: string): string {
  return canonicalNamespaceWith(namespace, sharedNamespaceEnvironment());
}

/** Translate the canonical name to the physical one a predicate must bind. */
export function physicalNamespace(namespace: string): string {
  return physicalNamespaceWith(namespace, sharedNamespaceEnvironment());
}

/** True when a non-admin write to the legacy shared namespace must be refused. */
export function shouldRejectLegacySharedWrite(
  auth: AuthInfo,
  targetNamespace: string,
): boolean {
  return shouldRejectLegacySharedWriteWith(
    auth,
    targetNamespace,
    sharedNamespaceEnvironment(),
  );
}
