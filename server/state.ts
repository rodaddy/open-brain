/**
 * What the rewrite under `server/` actually is, right now.
 *
 * This object exists so that "the rewrite is done" can never be asserted in
 * prose alone: three test files read it and fail if the declared state and the
 * wired reality disagree (`contracts/server-contract-providers.test.ts:13-25`,
 * `server/application/shadow-application.test.ts:107-108`,
 * `server/application/sdk-protocol.pg.test.ts:398-399`).
 *
 * THIS IS THE CUTOVER. `_plans/463-server-rewrite-charter.md` §4 Phase 6 makes
 * the flip an explicit, operator-gated act rather than a drift: the serving
 * entrypoint changes to `server/main.ts`, and the flags below change with it in
 * the same commit. Flipping them is not a status update about work that already
 * happened elsewhere -- it and the entrypoint change ARE the same decision, so
 * a green suite with `servesTraffic: true` and a chain still pointing at
 * `src/index.ts` is a contradiction the pin test is there to catch.
 *
 * `law0` STAYS BELOW RUNNING ON PURPOSE. Merging this PR makes the rewrite the
 * configured serving target; it does not make it a process answering requests.
 * Per the Development LAW-0 ladder, "merged" and "running" are different kinds
 * of true, and the deploy to the local clone -- not this file -- is what earns
 * the upgrade. Whoever proves `/health` on the deployed rewrite may raise this
 * to `RUNNING`; nobody should raise it from a passing test suite.
 *
 * `src/` IS THE ROLLBACK AND STAYS BYTE-UNTOUCHED. The charter's strangler rule
 * is absolute: old modules are retired only after the candidate has been proven
 * RUNNING. Until then, reverting the spawn target restores the previous server
 * with no code motion, which is the entire reason this cutover is one flag and
 * one argument instead of a deletion.
 */
export const SERVER_REWRITE_STATE = {
  law0: "MERGED",
  phase: "cutover",
  servesTraffic: true,
  cutoverStarted: true,
} as const;
