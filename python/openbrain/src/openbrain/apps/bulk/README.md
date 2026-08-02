# bulk

<!-- generated from __init__.py -- do not edit by hand -->

The bulk ingester: suck a whole giant session file in, lose none of it.

Purpose:
    The SECOND application (#454, `_plans/python-port-sequence.md` §TWO
    APPLICATIONS). An operator runs it, rarely, over a giant session file -- 27
    MB measured -- from anywhere. Claude transcripts and observed Codex rollout
    JSONL are built; Hermes remains unbuilt until an observed contract is
    charted. It has no deadline, no watermark, and every normalized turn in the
    file goes to the raw lane whole.

Architecture:
    This is a DISTINCT application from the live adapter (`apps/capture/`), and
    the split is the operator ruling of 2026-07-31: *"those are distinctly
    different applications."* The live adapter is a `Stop` hook with a hard
    5-second deadline that reads a few KB from a watermark and sees exactly ONE
    format. It must never see any bulk concern -- no format factory, no
    whole-file read, no SQLite staging, no Hermes -- because a hook attached to
    one harness only ever meets that harness's format, so dispatch on the
    deadline-critical path is complexity for a case that cannot occur.

    The bulk app REUSES the live ingester's PURE parts by IMPORT, never by copy
    (operator: *"reuse already working code, good."*):

        records.raw_turn_from_line   one JSONL line -> a RawTurn or None
        signal.signal_from           one operator string -> a typed signal

    Both are pure functions over a line or a string, with no I/O and no state,
    so this app imports them directly and adds only what is genuinely its own:

    Key Components:
        - formats: the FACTORY keyed on input type. It belongs HERE, not on the
          deadline-critical live path. Claude reuses the capture parser; Codex
          validates observed rollout events; Hermes raises loudly until charted.
        - staging: the SQLite staging store. The whole file goes in, is
          rejiggered into RawTurns, and each one pops off and yields -- the
          store decided 2026-07-31 02:15. It also carries the resume and
          quarantine state an operator run needs.
        - ingest: the orchestrator. Stage a file through its format adapter,
          then yield each staged turn to the writer, marking it sent so a
          re-run resumes rather than re-sends, and quarantining a turn the
          server rejects.
        - run: the console-script entrypoint. Builds the real
          `openbrain_memory` client and drives the ingest, failing LOUD.

Pattern/Convention:
    NOTHING HERE BOUNDS, SHORTENS, OR SAMPLES CONTENT. A turn is carried whole,
    byte for byte, exactly as the live adapter carries it
    (`docs/CODING_STANDARDS.md:160`; a number in a test is an INPUT SIZE). The
    staging store loads the WHOLE file because the +90 MB RSS to extract 85 KB
    measurement is why staging exists, not a reason to cap.

    OPERATOR-RUN MEANS LOUD. Unlike the live adapter, which swallows every
    failure so it cannot break the session it observes, the bulk app is run by a
    person who can act: it retries, it quarantines a turn the server rejects,
    and it resumes an interrupted run -- but it NEVER fails silently.

    Writes route ONLY through the `openbrain_memory` client
    (`AgentMemory.ingest_raw_turns`), never a second DB or HTTP path -- *"a
    second implementation is a defect on sight"* (`_plans/python-port-sequence.md`
    §THE WRITE PATH ALREADY EXISTS). This app never touches the live adapter's
    watermark or its hook path.

See Also:
    - `_plans/python-port-sequence.md` §TWO APPLICATIONS - the ruling this obeys
    - `openbrain.apps.capture.records` / `.signal` - the pure parts it reuses
    - `docs/decisions/capture-never-drops-a-turn.md` - what may not be dropped

---

Generated from the module docstring in `__init__.py`. To change this
file, edit that docstring and run
`python scripts/pytools/generate_package_docs.py --write`.
