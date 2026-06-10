import type { Request, Response, NextFunction } from "express";
import { logger } from "../logger.ts";

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();

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
