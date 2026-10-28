/**
 * The `/api/v1` REST router. Route handlers live in the sibling family modules
 * (`rest-api-entries.ts`, `rest-api-people-sessions.ts`, `rest-api-reads.ts`)
 * and shared plumbing in `rest-api-helpers.ts`; this file only wires paths to
 * handlers so the surface is readable at a glance.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { asyncHandler, type RestDeps } from "./rest-api-helpers.ts";
import { postDecision, postThought } from "./rest-api-entries.ts";
import { postPerson, postSession } from "./rest-api-people-sessions.ts";
import { getEntry, getNamespaces, getSearch } from "./rest-api-reads.ts";

export type { RestDeps } from "./rest-api-helpers.ts";

type FamilyHandler = (deps: RestDeps, req: Request, res: Response) => Promise<void>;

function bind(deps: RestDeps, handler: FamilyHandler) {
  return asyncHandler((req: Request, res: Response) => handler(deps, req, res));
}

export function createRestRouter(deps: RestDeps): Router {
  const router = Router();

  router.post("/thoughts", bind(deps, postThought));
  router.post("/decisions", bind(deps, postDecision));
  router.post("/persons", bind(deps, postPerson));
  router.post("/sessions", bind(deps, postSession));
  router.get("/search", bind(deps, getSearch));
  router.get("/entries/:table/:id", bind(deps, getEntry));
  router.get("/namespaces", bind(deps, getNamespaces));

  return router;
}
