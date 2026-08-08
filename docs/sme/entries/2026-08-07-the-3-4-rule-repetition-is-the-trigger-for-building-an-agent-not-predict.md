---
lane: gotcha-agent
order: 39
section: harvest-522
---
## [2026-08-07] The 3-4 rule: repetition is the trigger for building an agent, not predicted value

**Severity:** MEDIUM. **Status:** open process rule — operator direction,
2026-08-07.

Asked when a project-specific agent is worth creating, the agent proposed a
predictive test ("does the knowledge accumulate?"). The operator replaced it
with an observable one:

> "anything that you've had to do manually 3 or 4 times or in your personal
> context 3 or 4 times should have enough information to make an agent to do
> that for you."

The difference matters. "Will this accumulate knowledge?" requires predicting
the future and is answered by opinion. "Have I done this four times?" is
counted. It is the same measure-don't-theorize discipline as the
[2026-08-07] pro/con entry above, applied to tooling decisions.

Evidence from the session that produced this entry — work done by hand,
repeatedly, in ONE session:

| Repeated action | Count | Outcome |
|---|---|---|
| `aqmd search` to clear the design-lookup gate | 6 | Same three-step dance every time |
| "read the existing skill before proposing" | 5 | **Skipped 3 of 5 until corrected** |
| Probe before deciding | 3 | Only done after two operator corrections |

The middle row is the load-bearing one: a full grilling procedure was
improvised while `_ob/skills/what-did-i-not-ask/_DOCS/grill-with-docs-procedure.md`
already existed on disk and specified it. That is not a knowledge-accumulation
gap; it is a check-whether-this-is-already-solved step failed four separate
times in one session — precisely the 3-4 threshold.

Checks for the next swarm:

- **Count, do not predict.** If a manual action has happened 3-4 times in this
  repo or this session, it has enough information to be encoded. Do not argue
  about whether it will pay off later.
- **Pick the cheapest mechanism that holds** (`AGENTS.md` mechanism hierarchy:
  deny rule → environment → hook → prose). Deterministic and repeatable → a
  script. Judgment that varies per case → an agent. The 3-4 rule says *build
  something*; the hierarchy says *what*.
- **Repo-local agents live in `.claude/agents/`.** Verified 2026-08-07: this
  repo has no such directory and all 8 available agents are global
  (`~/.claude/agents/`). A project-specific agent here would be the first, so
  there is no local convention to copy yet — check again before assuming one.
- **Agent creation is not `skill-maintainer`'s job.** That skill owns
  `_ob/skills/<slug>/` canonicals and their runtime adapters (four verbs:
  create/update/audit/sync). An agent definition is a different artifact.
