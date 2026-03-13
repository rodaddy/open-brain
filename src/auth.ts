import type { AuthInfo } from "./types.ts";
import type { Request, Response, NextFunction } from "express";

// Stub: TDD RED phase -- will be properly implemented after tests confirm failure
export function buildTokenMap(
  _env: Record<string, string | undefined>,
): Map<string, AuthInfo> {
  return new Map();
}

export function verifyToken(_provided: string, _expected: string): boolean {
  return false;
}

export function authMiddleware(
  _tokenMap: Map<string, AuthInfo>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (_req: Request, _res: Response, _next: NextFunction) => {
    // stub -- does nothing
  };
}
