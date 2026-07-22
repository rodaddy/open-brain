# openbrain-memory-ts

Bun/TypeScript memory client for Open Brain — the contract peer of
`python/openbrain-memory` (#312). It is implemented against the shared
runtime-neutral fixture set in `contracts/memory/` and passes the identical
scenarios the Python client passes (`clients/ts/tests/contract-fixtures.test.ts`
is the structural mirror of
`python/openbrain-memory/tests/test_contract_fixtures.py`).

No npm publish tooling: this package is consumed in-repo (and by
Development-side adapters via path import). It shares the root `node_modules`
and the root `bunx tsc --noEmit` typecheck (`clients/ts/**/*.ts` is in the root
`tsconfig.json` include).

## What it provides

- **Contract declaration on the wire.** Every MCP request carries
  `X-OB-Contract: <contract_id>;schema_hash=<hash>`. The id and schema hash are
  derived from the server source of truth (`src/contract.ts` `buildContract`),
  never forked literals (`clients/ts/src/contract.ts`).
- **Bearer HTTP client over fetch** (`OpenBrainClient`): MCP streamable-http
  (initialize → notifications/initialized → tools/call), SSE-aware response
  decoding, expired-session re-initialization, secret-redacted error bodies,
  `https`-or-localhost base-url policy. Method names are the wire tool names
  (`session_start`, `append_session_event`, `session_wrap`,
  `agent_context_pack`, …) so spooled operations dispatch by name exactly like
  the Python runtime router.
- **First-class runtime** (`FirstClassMemoryRuntime`): the lifecycle surface
  `sessionStart` / `captureDistilled` (capture) / `checkpoint` / `wrap` /
  `recallContext` (recall) with truthful `openbrain.runtime_receipt.v1`
  receipts (`direct`/`saved`/`spooled`/`failed`/`lost` plus the drain statuses
  `replayed`/`quarantined`).
- **Exact-scope session proof (#294).** Every `session_start` result must
  prove the requested lane (`namespace`, `session_key`, `agent`, `source`,
  `server_id`, `channel_id`, `thread_id`) and every `agent_context_pack`
  result must prove the full requested scope. Mismatches fail open (status
  `failed`, empty context) — there is no fallback route to mask them.
- **JSONL spool** (`JsonlSpool`): same caps and semantics as the Python spool
  (`docs/memory-limits.md`) — 1000-line cap, 1,000,000-byte cap,
  `SpoolFullError` backpressure that never mutates acknowledged records,
  atomic tmp+rename rewrites with `0600` file mode, and
  **redact-before-persist**: every payload passes `redactValue` before disk;
  nothing unredacted reaches the spool or any sidecar. Every record spooled by
  the runtime carries the `_parked_namespace` provenance marker (#314,
  PR #317). Spool durability and replay cover this **redacted persisted
  representation**, not the caller's exact original payload bytes.
- **Scope-aware auto-drain (#307/#310/#314).** Healthy direct recalls and
  saved writes replay pending spool units through the explicit durable
  allowlist (`session_start`, `lane_upsert`, `upsert_repo_fact`,
  `append_session_event`, `log_thought`, `log_decision`, `session_wrap`) in
  original order. `session_start` units replay under their parked exact scope;
  foreign-namespace parked units are retained — never dispatched, never
  counted as failures. Delivery is at-least-once (dedupe on
  `idempotency_key`).
- **Drain receipts + quarantine (#296/#308).** `REPLAYED` per replayed record
  and `QUARANTINED` per quarantined unit, inside the pinned
  `openbrain.runtime_receipt.v1` schema. A unit that fails 5 consecutive
  replay attempts moves atomically to the `<spool>.quarantine.jsonl` sidecar
  behind a content-free envelope (error CLASS name only, never message
  bodies), with replace-not-skip re-quarantine, success reconciliation of
  stale entries, and counters persisted in `<spool>.retry-state.json`.
- **Public receipts** (`publicReceipt`, `errorCategory`): the bounded
  TS-owned `error_category` taxonomy — `scope-proof-failed`, `http-auth`,
  `http-error`, `network`, `spool-full`, `invalid-request`, `other` — with
  unknown mapping to `other` and no free text ever
  (`ts-public-receipt-error-category-v1` fixture).

## Usage

```ts
import {
  FirstClassMemoryRuntime,
  RuntimeScope,
  publicReceipt,
} from "../../clients/ts/src/index.ts";

const runtime = new FirstClassMemoryRuntime(
  {
    baseUrl: "https://open-brain.example",
    token: process.env["OPENBRAIN_TOKEN"] ?? "",
    namespace: "bilby",
    spoolPath: "/path/to/agent-spool.jsonl",
  },
  new RuntimeScope({
    agent: "bilby",
    platform: "discord",
    serverId: "guild-1",
    channelId: "channel-2",
    threadId: "thread-3",
    sessionKey: "repo/session-4",
  }),
);

await runtime.sessionStart();
const captured = await runtime.captureDistilled("Decision: keep parity executable", {
  eventType: "decision",
});
const recall = await runtime.recallContext("What contract decisions apply?", {
  maxTokens: 1200,
  requestedSections: ["durable_lane_context"],
});
await runtime.checkpoint("Mid-session checkpoint", {
  keyDecisions: ["Fixtures are the parity source"],
});
await runtime.wrap("Session complete");
await runtime.close();

// Adapter-facing receipt: bounded category, no free error text.
console.log(publicReceipt(captured.receipt));
```

Only **distilled** content belongs in memory: captures and wraps reject
payloads over 16 KiB and fail closed on secret-like material
(`SECRET_PATTERNS`). Write degradation ladder: `saved` → `spooled` (durable
locally, auto-replayed) → `failed`/`lost` (loud in the receipt, never silent).

## Validation

```sh
bunx tsc --noEmit           # root typecheck covers clients/ts
bun test clients/ts/        # unit tests + contract fixture runner
bun contracts/check-parity.ts
```

## Intentional differences from the Python client (runtime-specific)

- **No mcp2cli subprocess fallback.** `fallback_attempted` is always `false`;
  scope mismatches and outages degrade to spool/receipts directly.
- **Portable cross-process spool lock.** The TS spool uses an atomic-create
  lock file with bounded waits, dead/stale-owner recovery, and token-safe
  release around local snapshot/read-modify-write and replay reconciliation.
  It never holds that lock across replay dispatch/network calls. Atomic writes
  require directory durability proof; a failed proof restores the prior bytes
  (or prior absence) before reporting failure.
- **No client-version range validation** against `min_client_versions` /
  `compatible_client_ranges`: the server manifest does not yet declare a
  TypeScript-client entry, so validating an absent entry would fail closed
  against every live server. Scope/version/schema-hash/tool checks are
  enforced.
- **No `AgentMemory` surface** (`record_receipt`, disclosure bundles,
  candidate lifecycle). The `receipt-shapes` capability stays
  `runtime-specific` in `contracts/memory/parity-manifest.json`; the TS-owned
  public `error_category` taxonomy fixture covers the TS receipt surface.

## Not included (by design, per #312 non-goals)

- **No adapter cutover.** The Development-side `_ob` memory-provider adapter
  still runs the Python client; switching it to this package is a
  Development-side follow-up with its own rollout gate
  (`docs/downstream-rollout.md`).
- No Python client changes, no server changes.
