# Open Brain web service — long-lived operator surface

Issue: **#437**. **DEFERRED until DREAM works** — blocked by #435 and #436.
Date: 2026-07-28

Operator, 2026-07-28: *"I think we need to get this dream stuff done before we
start writing a fucking front end for it."*

This plan exists so the stack decision and its reasoning are not re-derived. It
is not scheduled work.

---

## What this replaces

`src/grading-server.ts` is a standalone `Bun.serve` listener bound to 127.0.0.1,
serving one hand-written HTML page (`src/grading-page.ts`) over the data layer in
`src/candidate-review.ts`. It was built for a single purpose and is good at it.

The operator wants something long-lived: *"a better web service that does all the
things that we need it to and can be bound to 0.0.0.0 and if need be added into
Caddy ... so I could just go to <hostname> and there you go."*

### The loopback rationale must be replaced, not overridden

`src/grading-server.ts:19-26` states that **loopback IS the auth boundary** — the
page has no authentication at all, deliberately, because only the machine it runs
on can reach it. It also warns:

> The hostname is **NOT configurable**: making it an env var is how a
> loopback-only service ends up on 0.0.0.0 during a debugging session and stays
> there.

That reasoning is sound for loopback and collapses the moment it binds to a
network. Binding wider **requires** real auth in the same change, and that
comment must be rewritten to state the new boundary — not left in place as a
stale rationale.

---

## Surfaces (all four; operator: "better to wire them in and not need them")

| Surface | Interaction shape |
|---|---|
| Grading / review queue | Batch staging — mark N items, submit as one transaction. Real client state. |
| Search & browse memory | Semantic search, browse by namespace/tier/project, open a record with provenance and relationships. Navigation-heavy. |
| Dashboard / health | What DREAM did: hourly runs, agreement rate over time, queue depth, capture rate. Read-only, charts. |
| Edit / curate memory | Tier changes, merges, corrections, deletes. Write access to durable memory. |

---

## Stack: Next.js, matching `king-capital/king-dashboard`

**Correcting an error made in this session:** an earlier search concluded there
was "no frontend precedent in the fleet." That was wrong — `fd` honors
`.gitignore`, so every frontend was invisible. There are 15+ across
`/Volumes/ThunderBolt/Development`, and **Next.js is the dominant choice**
(king-dashboard, king-trading, king-market-data, rtech-portal, bulkbridge,
rodaddybench/dashboard, rtech-document-studio, bulkbridge/client-app). Vite+React
and one SvelteKit app (`fabric/web`) also exist.

`king-capital/king-dashboard` v0.2.56 is the reference implementation:

> Next.js 16, React 19, Tailwind 4, radix-ui, drizzle-orm, **better-auth**,
> pino, zod, recharts, react-hook-form, Biome. Bun-run throughout
> (`bun --env-file=.env.local`).

Reasons this fits, beyond precedent:

1. **The operator does not enjoy frontend design** — *"I'm not very good at those
   designs."* radix-ui + Tailwind gives a competent UI without designing one, and
   king-dashboard is a working reference to copy patterns from.
2. **better-auth** answers the auth question directly. Single account now; it has
   OIDC providers when Authentik is wanted. Operator: *"it would be one for now,
   and if we really end up caring about auth ... we can run it through
   Authentik."* No hand-rolled session cookie.
3. **recharts** is already the fleet's answer for the dashboard surface.
4. **Server components + route handlers** mean no separate API layer.

### One deliberate divergence: NO Drizzle

king-dashboard uses drizzle-orm. Open Brain uses raw `pg` with hand-written,
parameterized SQL, and repo rules require it: *"Keep SQL parameterized. Table
names may be interpolated only after Zod enum validation."*

`src/candidate-review.ts:12-18` keeps SQL in the data layer specifically so the
rules are testable without a socket. The web app **calls that existing module**
server-side; it does not re-query the tables through a second ORM. Two query
paths against the same rows is how a namespace-isolation predicate gets forgotten
in one of them — and namespace isolation is a security boundary here.

### Shape

```
open-brain/
  src/            unchanged — MCP server, port 3100
  web/            new Next.js app, its own port
    app/          grade | search | dashboard | curate
    lib/db.ts     imports ../../src/candidate-review.ts
```

One set of rules, one set of tests, two front doors.

**Port note:** king-dashboard dev-runs on 3100, which is also open-brain's MCP
port on core01. Different hosts so no real collision, but this app needs its own.

---

## Auth and exposure

- **better-auth, single operator account**, session cookie.
- **Bind `0.0.0.0` behind Caddy** with TLS terminated there.
- `graded_by` already exists in the schema and wants a real identity — this is
  not wasted work even at one account.
- Authentik later is a provider swap confined to one place.

---

## Cost, stated honestly

Next.js brings a build step and a large dev-dependency tree to a repo that today
has 7 runtime deps and no bundler. `_DOCS/STANDARDS-core.md` favors minimal. The
mitigation is that they are **dev** dependencies — the built output is static
plus a server, and the MCP server's own runtime dependency list does not change.

That trade is accepted because the alternative — hand-written HTML strings across
four growing surfaces — is what the current single page already is, and it does
not extend.

---

## Prior art consulted

openhuman (`/Volumes/ThunderBolt/open-brain-local/research/openhuman/`, indexed;
`aqmd in openhuman "..."`) was the operator's reference. Its `app/src/` is React +
react-router + Redux packaged with Tauri. Most of that stack solves problems this
service does not have — desktop packaging, web-to-desktop token exchange with
5-minute TTL, onboarding flows, keychain storage, mobile routes.

Worth taking is the shape, not the stack:

- session-token auth with a real login, not "the network is the boundary"
- routes as first-class surfaces, not one page with modes
- no credentials in localStorage (they use Redux + OS keychain; browser-only
  means httpOnly cookies)

Attribution obligations if anything is borrowed: `docs/prior-art/ATTRIBUTION.md`.

---

## Blocked by

`_plans/435-436-dream-hosted-rem.md` — the whole DREAM sequence. A front end over a
pipeline that does not yet produce trustworthy grades would be built against a
moving target.
