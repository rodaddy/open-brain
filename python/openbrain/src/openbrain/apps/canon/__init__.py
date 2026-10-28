"""The canon reconciler: keep the file that declares canon and the rows that serve it in sync.

Purpose:
    Canon had a reader and two writers and no SOURCE. `agent_context_pack` reads
    three lanes; `append_session_event` and `upsert_repo_fact` write the rows
    behind them (#445, answered from live source 2026-07-30). Nothing ever said
    which rules canon was SUPPOSED to hold, so nothing could tell that all three
    lanes measured zero items while the machinery was "provably working --
    returning the right answer to a question with no data behind it". A person
    querying Postgres by hand was the only detector.

    This app is the missing half: a declarative pack FILE is the source of truth,
    the live pack is compared against it, and the difference is a report. Run it
    and canon either matches the file or names exactly where it does not.

Architecture:
    Four modules, mirroring `apps/bulk`'s shape -- format, capability, capability,
    entrypoint:

    Key Components:
        - pack: the canon/lens pack FILE FORMAT. Pydantic models over TOML,
          carrying the stable `candidate_scope.key` that #445 established as the
          write-side prerequisite. Its `kind` field is the discriminator a lens
          pack would use; see the note below.
        - reconcile: the diff. Pure functions from (declared pack, live pack) to
          a `DriftReport` of matched/missing/stale/undeclared findings. No client,
          no endpoint, no I/O -- which is what makes the whole engine testable
          against a captured payload.
        - writes: the mapping from a declared entry to the EXACT tool call that
          lands it, held as data so a dry run prints what it would send instead
          of describing it.
        - run: the console-script entrypoint, `openbrain-canon-reconcile`.

Pattern/Convention:
    THE DIRECTION IS FILES -> OPEN BRAIN, AND ONLY THAT. The pack file is the
    original; the rows are the projection (`_plans/canon-always-known.md`,
    "Skills stay in files": rows lose diffs, history, and review). So a rule
    declared and not standing is written; a rule whose text drifted is rewritten;
    a rule standing that no file declares is REPORTED and never touched.

    NOTHING IS EVER DELETED, and there is no delete surface to call: retiring a
    canon rule is a newer `relegate` on the same scope key (#445), which is a
    WRITE. `writes.plan_retire` exists so that path is typed in the same place,
    but the reconcile run never calls it -- an undeclared row is as likely to be
    a rule an operator promoted by hand as a leftover, and this tool does not get
    to decide which.

    DRY RUN IS THE DEFAULT. Canon is an AUTHORITY model, not a decay model
    (`docs/code-brain-design.md`: canon > decided > observed), and #444 -- what
    canon actually contains -- is an open HITL grilling ticket that says "Rico
    decides; do not answer this one alone". A tool that promoted rules on sight
    would be answering it. `--apply` is the operator saying the file is the
    decision.

    NOTHING BOUNDS RULE TEXT. No length cap, no truncation, no normalisation
    beyond stripping surrounding whitespace (`docs/CODING_STANDARDS.md`
    section 6). The read side already had its ceilings torn out because an
    895-character standing rule was arriving severed; a source format that
    re-imposed one would put that defect back on the write side, and a drift
    check that compared shortened text would silently call two different rules
    equal -- the one thing it must never do.

    ON THE LENS QUESTION: `pack.PackKind` has exactly one member, `canon`.
    Persona-as-a-thinking-lens is #452, an OPEN grilling ticket, and its own text
    warns that "storing a lens beside the rules risks an agent treating a stance
    as a standing rule". So no lens structure is invented here. What is built is
    the discriminator that makes answering it cheap: a lens pack becomes a new
    `PackKind` member with its own lane mapping, not a second file format. Any
    other `kind` is REJECTED at parse today, so a speculative lens file cannot
    quietly promote a stance into the standing rules while #452 is still open.

See Also:
    - `_plans/canon-always-known.md` - the canon model this serialises
    - `_ob/skills/brain/workflows/canon.md` - canon vs episodic, and why
    - `_plans/issues/445-...` - the two write paths, established from live source
    - `openbrain.apps.hooks.session_start` - the reader this checks against
"""
