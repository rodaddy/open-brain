# Attribution

Open Brain borrows from other projects. Standing rule: **all credit given where
taken — code *or* idea.** An idea does not become ours because we typed it
ourselves.

This file lists every project we have studied and what, if anything, we took
from it. It is maintained alongside `docs/prior-art/`, where the reasoning for
each borrow is recorded in full.

## How to use this file

- Borrowing an **idea** still requires an entry here. Name the project, the
  concept, and where our implementation lives.
- Borrowing **code** requires an entry here *and* a license check *and* a
  comment at the borrow site naming the source.
- Deciding **not** to borrow is also worth recording. A cautionary finding is a
  result, and it stops the next person re-evaluating the same thing.

## We use ideas, not code

Open Brain takes **no code** from any of these projects and depends on none of
them. Verified 2026-07-27: no import, require, or dependency on honcho, cognee,
graphiti, mem0, or gbrain anywhere in `src/`, `python/`, or `scripts/`, and none
in `package.json` or `pyproject.toml`. The only reference in the codebase is a
comment in `src/db/migrations/032_raw_turns.test.ts:282` crediting Graphiti for
the bi-temporal concept — credit for an idea, which is the practice this file
exists to keep.

That is the intended posture, not an accident. We read prior art to understand
problems other people already solved, then implement our own. The licence table
below therefore documents what *would* apply if that ever changed; it is not a
description of current obligations.

## Licenses — verified from the clones, not assumed

Read from each project's own `LICENSE` file on 2026-07-27. Relevant only if
someone proposes copying code, which today nobody has.

| Project | Upstream | License | Code reuse |
|---|---|---|---|
| gbrain | github.com/garrytan/gbrain | **MIT** | permitted with attribution |
| cognee | github.com/topoteretes/cognee | **Apache-2.0** | permitted with attribution + NOTICE |
| cognee-integrations | github.com/topoteretes/cognee-integrations | **no LICENSE file** | **do not copy code** — unlicensed by default |
| graphiti | github.com/getzep/graphiti | **Apache-2.0** | permitted with attribution + NOTICE |
| honcho | github.com/plastic-labs/honcho | **AGPL-3.0** | **do not copy code** — see below |
| mem0 | github.com/mem0ai/mem0 | **Apache-2.0** | permitted with attribution + NOTICE |

Two entries are stricter than the rest, worth knowing before anyone changes the
no-code posture. **Honcho is AGPL-3.0** — copying its source would place Open
Brain under AGPL, network-use clause included, which reaches a hosted
deployment. **`cognee-integrations` ships no LICENSE file**, so the default is
exclusive copyright and there is no permission to copy at all. Both are fine to
read; neither is a file to lift.

Recorded because an earlier borrow-list (2026-07-24) said "cognee/mem0/graphiti
are Apache-2.0 so borrowing is fine" and did not mention these two.

## Credit for showing us what not to do

Not every debt is a borrowed feature. Some of these projects earned credit by
being tried, falling short for this use, and making the requirement obvious in
a way no design document would have. That is a real contribution and it belongs
here, named, not quietly folded into "we decided to build our own."

**Honcho** is the clearest case. Open Brain exists in its current shape partly
because Honcho was used and found wanting for this workload — and the specific
ways it fell short are what defined what Open Brain had to be instead. The
standing decision that Honcho "is not a valid memory option and must not be
treated as coming back" is not a dismissal of the project; it is the record of a
question already settled by experience. Credit to Honcho for making the shape of
the problem concrete.

The lesson generalises: a system you actually ran teaches you more than one you
read about. Reviews in this directory should say plainly when a finding came
from *using* something rather than reading it, because that evidence is stronger
and rarer.

## What we have taken

Filled in as each prior-art review completes. An empty cell means the review has
not been done yet — not that nothing was taken.

| From | What | Kind | Where it lives in Open Brain |
|---|---|---|---|
| graphiti | Bi-temporal fact modelling — separating when a fact was true in the world from when we learned it | idea | see `docs/prior-art/graphiti.md` |
| cognee | Lifecycle capture wired across all six agent hook surfaces | idea | see `docs/prior-art/cognee.md` |
| cognee | Idle detection as a detached process rather than an in-agent policy | idea | see `docs/prior-art/cognee.md` |
| gbrain | One-shot and scheduler as separate commands over a single shared cycle primitive | idea | see `docs/prior-art/gbrain.md` |
| gbrain | TTL table-row cycle lock (survives a transaction pooler), per-phase lock requirement, heartbeat-aware steal grace | idea | see `docs/prior-art/gbrain.md` |
| gbrain | Paired cost *and* walltime caps on maintenance phases | idea | see `docs/prior-art/gbrain.md` |
| gbrain | Autonomy boundary drawn at reversibility — self-modifying work proposes, does not apply | idea | see `docs/prior-art/gbrain.md` |
| gbrain | Extractor version watermark that invalidates previously-derived rows | idea | see `docs/prior-art/gbrain.md` |
| mem0 | *Cautionary.* Reviewed and deliberately not adopted — see `docs/prior-art/mem0.md` | — | not adopted |
| ponytail (`linsomniac/ponytail`) | Replaced-file detection by `(device, inode)` rather than size, so rename/create rotation is noticed | idea | `python/openbrain/src/openbrain/apps/capture/transcript.py` (`_start_position`) |
| OpenTelemetry filelog receiver | Naming the two rotation cases separately — rename/create vs copytruncate — and reading the whole file on either, because re-reading is recoverable and skipping is not | idea | same |
| logtail2 / pygtail | The offset-file model itself: read forward from a stored position instead of guessing how far back to look | idea | `python/openbrain/src/openbrain/apps/capture/watermark.py` |

**Not adopted, and why.** `pygtail` is the best-known implementation of this
idea and was rejected on licence: it is **GPL v2**, and this repo's standing
posture (see Honcho above) is that copyleft reaching a hosted deployment is not
acceptable. `ponytail` matches the use case most closely but has two releases
total and unverified licence and typing — `_DOCS/STANDARDS-core.md:225` warns
against trading a hand-rolled bug for an unmaintained dependency. `diskcache`
was rejected for the watermark store on evidence: it pickles values, manages a
filesystem directory beside the database, has had no release since 2023, and its
only typed helpers come from one author with no production signal, one of which
documents itself as untested. The ideas were taken; the dependencies were not.

## Local clones

Working copies live at `/Volumes/ThunderBolt/open-brain-local/research/`, outside
this repo so vendor source never enters our git history. They are read-only
reference material. Prior art is read **from source, not marketing** — that is
what made the existing findings usable.
