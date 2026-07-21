import type { Request, Response, NextFunction } from "express";
import { buildContract } from "../contract.ts";
import { logger } from "../logger.ts";

const EXPECTED_CONTRACT = buildContract("1970-01-01T00:00:00.000Z");
const CLIENT_CONTRACT_HEADER_RE =
  /^([A-Za-z0-9._-]{1,128});schema_hash=([a-f0-9]{64})$/;

// Tripwire throttle: at most one warn per distinct declared (contract id,
// schema_hash) per 5-minute bucket, so a stale client cannot amplify log
// volume request-by-request. Middleware is process-wide, so a module-scoped
// map suffices; all malformed headers collapse to one key. Log-only.
const WARN_BUCKET_MS = 5 * 60 * 1000;
const WARN_KEY_LIMIT = 1000;
const warnBucketByDeclaration = new Map<string, number>();

function shouldWarnForDeclaration(key: string): boolean {
  const bucket = Math.floor(Date.now() / WARN_BUCKET_MS);
  if (warnBucketByDeclaration.get(key) === bucket) return false;
  if (warnBucketByDeclaration.size >= WARN_KEY_LIMIT) {
    warnBucketByDeclaration.clear();
  }
  warnBucketByDeclaration.set(key, bucket);
  return true;
}

function warnOnContractMismatch(req: Request): void {
  const raw = req.headers["x-ob-contract"];
  if (raw === undefined) return;
  const declared = Array.isArray(raw) ? raw[0] : raw;
  const match = declared?.match(CLIENT_CONTRACT_HEADER_RE);
  if (!match) {
    if (!shouldWarnForDeclaration("malformed_header")) return;
    logger.warn("client_contract_mismatch", {
      method: req.method,
      path: req.path,
      reason: "malformed_header",
      expectedContractId: EXPECTED_CONTRACT.contract_version,
      expectedSchemaHash: EXPECTED_CONTRACT.schema_hash,
    });
    return;
  }

  const [, declaredContractId, declaredSchemaHash] = match;
  if (
    declaredContractId === EXPECTED_CONTRACT.contract_version &&
    declaredSchemaHash === EXPECTED_CONTRACT.schema_hash
  ) {
    return;
  }
  if (
    !shouldWarnForDeclaration(`${declaredContractId};${declaredSchemaHash}`)
  ) {
    return;
  }
  logger.warn("client_contract_mismatch", {
    method: req.method,
    path: req.path,
    reason: "contract_or_schema_mismatch",
    declaredContractId,
    declaredSchemaHash,
    expectedContractId: EXPECTED_CONTRACT.contract_version,
    expectedSchemaHash: EXPECTED_CONTRACT.schema_hash,
  });
}

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();
  warnOnContractMismatch(req);

  res.on("finish", () => {
    const durationMs = Math.round(
      Number(process.hrtime.bigint() - start) / 1_000_000,
    );

    logger.info("request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      consumerId:
        (req as any).auth?.tokenClientId ??
        (req as any).auth?.clientId ??
        "anonymous",
      effectiveNamespace: (req as any).auth?.clientId,
      namespaceSource:
        (req as any).auth?.namespaceSource === "header"
          ? "X-Namespace header"
          : (req as any).auth
            ? "token"
            : undefined,
      agentId: (req as any).auth?.agentId,
    });
  });

  next();
}
