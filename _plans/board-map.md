# Open Brain board map

The repo board map required by `_DOCS/BOARD_FIELDS.md`. Recorded 2026-08-04.

Agents should not rediscover project fields every run. Load the IDs below rather
than issuing `gh project field-list` as routine startup — see the API contract in
`_DOCS/BOARD_FIELDS.md` for when a live schema read is warranted. This file
exists so that call runs once and not once per session. Re-read the schema when
an ID is missing, this map looks stale, or GitHub returns a schema/validation
failure.

## Board

| Property | Value |
|---|---|
| Name | Open Brain Work Board |
| URL | https://github.com/users/rodaddy/projects/8 |
| Number | 8 |
| Owner | `rodaddy` (user) |
| Scope | **repo-linked user project** — user-owned, linked to this repo |
| Project node ID | `PVT_kwHOABBGmc4BbDBt` |

This satisfies the board-ownership rule: repo-scoped work runs on a repo-linked
board, not on a global cross-repo control plane.

## Automation owner

**Manual / controller-driven.** There is no workflow, action, or bot writing to
this board today. The controller (or its single designated board/scribe owner)
performs every field mutation; workers report evidence and do not touch the board
themselves. Anything this map calls a "transition" happens because a human or the
controller made it happen — do not assume a status moved on its own, and do not
infer issue state from the board without checking the issue.

## Fields

Single-select fields carry option IDs, since a `ProjectV2` mutation needs the
option ID rather than the label.

### Status — `PVTSSF_lAHOABBGmc4BbDBtzhV2Uic`

| Option | Option ID |
|---|---|
| Backlog | `9c5aa9e8` |
| Todo | `b85131b5` |
| In Progress | `fbccd60b` |
| In Review | `5297bfca` |
| Blocked | `fb7f5199` |
| Done | `ee9f14ee` |

### Priority — `PVTSSF_lAHOABBGmc4BbDBtzhV2UjI`

| Option | Option ID |
|---|---|
| P0 Critical | `952d2178` |
| P1 High | `2953b9e6` |
| P2 Medium | `ccedc84f` |
| P3 Low | `01faacb2` |

### Component — `PVTSSF_lAHOABBGmc4BbDBtzhV2UjM`

| Option | Option ID |
|---|---|
| Server Canonicalization | `9d258579` |
| Search/Fallback | `415985be` |
| Legacy Promoter | `7c0ac802` |
| Client Runtime | `aaad5283` |
| Identity/Auth | `241aa9b4` |
| Docs/Process | `bbd48f3b` |
| Review/Validation | `c881a0db` |
| Deploy/Canary | `d9106756` |
| Memory Protocol | `9ba49eda` |
| Synthesis | `c1c9092f` |
| Eval Harness | `25a7e080` |

### Surface — `PVTSSF_lAHOABBGmc4BbDBtzhV2UjQ`

| Option | Option ID |
|---|---|
| Server/API | `4ec4823c` |
| MCP/mcp2cli | `0dbee802` |
| Codex Skill | `0eccffdf` |
| All Surfaces | `9fc9caf1` |
| Python Client | `5d640946` |
| Hermes/Runtime | `d18c0206` |
| Docs/Process | `c55a6390` |
| Eval Harness | `af8e5222` |
| Deploy/Canary | `2d478ffe` |

`Component` and `Surface` both carry `Docs/Process`, `Deploy/Canary`, and
`Eval Harness` labels with **different option IDs**. They are different fields;
using one field's option ID against the other fails validation.

### Review Gate — `PVTSSF_lAHOABBGmc4BbDBtzhV2U9Y`

| Option | Option ID |
|---|---|
| Not Started | `1e1a0d7c` |
| Initial Swarm Pending | `d843dc05` |
| Initial Swarm Running | `4280b4e1` |
| Findings Posted | `14b9105f` |
| Fixes In Progress | `40bbff4e` |
| Fixes Posted | `3066d546` |
| Fix Verification Pending | `3024d5ff` |
| Fix Verification Running | `cd1423f9` |
| Zero Known Issues | `e282e2fa` |
| Deferred By Rico | `226f58e0` |

Mirrors the review-swarm lifecycle in `AGENTS.md` and the `review-swarm` /
`pre-merge-gauntlet` skills. `Deferred By Rico` is the only way out of the gate
without reaching `Zero Known Issues`, and the name says who may set it.

### Phase — `PVTSSF_lAHOABBGmc4BbDBtzhV2VJg`

| Option | Option ID |
|---|---|
| P0 Planning | `6f0c7702` |
| P1 Server Canonicalization | `fa7744fe` |
| P2 Client Runtime | `bcd64663` |
| P3 Identity/Auth | `413d2913` |
| P4 Legacy Promoter | `7f15d10b` |
| P5 Review/Validation | `8541af2b` |
| P6 Deploy/Canary Follow-On | `81f70d96` |
| Done | `3ac97e06` |

### Validation — `PVTSSF_lAHOABBGmc4BbDBtzhV2VKY`

| Option | Option ID |
|---|---|
| Not Started | `50bca655` |
| Local Passed | `1d8b2340` |
| CI Pending | `01f1211d` |
| CI Passed | `8ebbd255` |
| Live Check Pending | `fd197652` |
| Live Check Passed | `8cdb5fc8` |
| Blocked | `43d888d8` |
| Skipped With Reason | `25c25422` |

`Skipped With Reason` requires the reason to be written down where a reader will
find it — the PR body or the issue — not only in the board cell.

### Text and built-in fields

| Field | Node ID |
|---|---|
| Title | `PVTF_lAHOABBGmc4BbDBtzhV2UiU` |
| Assignees | `PVTF_lAHOABBGmc4BbDBtzhV2UiY` |
| Labels | `PVTF_lAHOABBGmc4BbDBtzhV2Uig` |
| Linked pull requests | `PVTF_lAHOABBGmc4BbDBtzhV2Uik` |
| Milestone | `PVTF_lAHOABBGmc4BbDBtzhV2Uio` |
| Repository | `PVTF_lAHOABBGmc4BbDBtzhV2Uis` |
| Reviewers | `PVTF_lAHOABBGmc4BbDBtzhV2Uiw` |
| Parent issue | `PVTF_lAHOABBGmc4BbDBtzhV2Ui0` |
| Sub-issues progress | `PVTF_lAHOABBGmc4BbDBtzhV2Ui4` |
| Created | `PVTF_lAHOABBGmc4BbDBtzhV2Ui8` |
| Updated | `PVTF_lAHOABBGmc4BbDBtzhV2UjA` |
| Closed | `PVTF_lAHOABBGmc4BbDBtzhV2UjE` |
| Target Date | `PVTF_lAHOABBGmc4BbDBtzhV2UjU` |
| Owner | `PVTF_lAHOABBGmc4BbDBtzhV2U8U` |
| Next Action | `PVTF_lAHOABBGmc4BbDBtzhV2VDQ` |

`Owner` and `Next Action` are free-text, not single-select — there are no option
IDs to look up, and a mutation sets them with a text value.

## Item IDs

Not recorded here. Per `_DOCS/BOARD_FIELDS.md`, dynamic project item IDs belong
in the controller ledger or run cache; a stable item ID enters this map only when
the item itself is durable. When an item ID is unknown, do one targeted lookup
for that issue or PR rather than listing the whole board.

## Exceptions requiring operator approval

- Using a different board for repo-scoped Open Brain work.
- Setting `Review Gate = Deferred By Rico`.
- Closing a goal run while this map is missing or stale.
