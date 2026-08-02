"""The canon pack FILE FORMAT: what a file-based canon source declares.

Purpose:
    Canon has a reader and two writers and no *source*. ``agent_context_pack``
    reads three lanes (``_ob/skills/brain/workflows/canon.md``);
    ``append_session_event`` and ``upsert_repo_fact`` write the rows behind them
    (#445, answered from live source 2026-07-30). What has never existed is a
    declarative file that says which rules canon is SUPPOSED to hold, so nothing
    can compare the intent against the rows. This module is that file's shape.

    A pack file is authored, reviewed, and diffed like every other file --
    ``_plans/canon-always-known.md`` "Skills stay in files": rows lose diffs, git
    history, and review, so the ORIGINAL lives in a file and Open Brain holds the
    projection. The pack is the original; the OB rows are the projection.

Architecture:
    Three types and one discriminator:

        PackKind    vocabulary  -- what a pack declares (``canon`` today)
        Lane        vocabulary  -- which of the three lanes an entry belongs to
        PackEntry   declaration -- one rule: its stable key, its text, its lane
        Pack        document    -- a file's worth of entries plus its kind

    ``kind`` exists because a pack file is not necessarily canon. Persona-as-a-
    thinking-lens is issue #452 and is an OPEN HITL grilling ticket -- explicitly
    undecided, and it warns that "storing a lens beside the rules risks an agent
    treating a stance as a standing rule". So no lens structure is invented here.
    What IS built is the discriminator that keeps the decision cheap: when #452
    resolves, a lens pack is a new :class:`PackKind` member and its own lane
    mapping, NOT a second file format and not a change to this one. Until then
    ``canon`` is the only accepted kind and anything else is REJECTED at parse,
    so a speculative ``kind: lens`` file cannot quietly promote a stance into the
    standing rules.

Pattern/Convention:
    EVERY ENTRY CARRIES A SCOPE KEY, AND IT IS THE POINT. #445 established that
    the guidance lanes reconcile supersession only through an explicit typed
    ``metadata.candidate_scope.key``: standing state per key is the NEWEST
    lifecycle action for that key, so retiring a rule is writing a newer
    ``relegate`` on the same key. A promoted row with no key "cannot be proven
    current" (``src/tools/agent-context-pack-guidance.ts``). The key is therefore
    a REQUIRED field, not an optional one -- a pack that omits it authors rows
    that can never be cleanly retired, which is the exact defect #445 flagged as
    the write-side prerequisite.

    NOTHING HERE BOUNDS CONTENT. No maximum rule length, no truncation, no
    summarisation (``docs/CODING_STANDARDS.md`` section 6). A rule is rejected
    only for being structurally unusable -- an empty key or empty text is not a
    rule -- never for its size. The read side already had its ceilings removed
    for precisely this reason (a 895-character standing rule was arriving
    severed); a source format that re-imposed one would put the defect back on
    the write side.

Example:
    >>> pack = Pack.model_validate(
    ...     {
    ...         "kind": "canon",
    ...         "entries": [
    ...             {
    ...                 "key": "process.no_tmp",
    ...                 "lane": "process_guidance",
    ...                 "text": "Never /tmp. Use the temp workspace.",
    ...             }
    ...         ],
    ...     }
    ... )
    >>> pack.entries[0].candidate_type
    'process_rule'

See Also:
    - ``_plans/canon-always-known.md`` - the canon model this serialises
    - ``_ob/skills/brain/workflows/canon.md`` - canon vs episodic
    - ``src/tools/agent-context-pack-guidance.ts`` - the scope-key mechanism
    - ``_plans/issues/452-...`` - the lens question this deliberately does not answer
"""

from __future__ import annotations

import tomllib
from enum import StrEnum
from typing import TYPE_CHECKING, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

if TYPE_CHECKING:
    from pathlib import Path


class PackKind(StrEnum):
    """What a pack file declares.

    One member today. ``lens`` is deliberately absent: #452 has not decided
    whether a thinking lens is the same object as canon, and the ticket's own
    warning is that a stance stored beside the rules gets read as a standing
    rule. Adding a member here is the whole cost of answering it.
    """

    CANON = "canon"


class FactType(StrEnum):
    """The ``repoFactMetadata.fact_type`` enum, mirrored from ``src/tools/repo-facts.ts``.

    Mirrored as a closed set for the same reason :class:`Lane` is: the server
    validates it with ``z.enum(FACT_TYPES)``, so an unrecognised value fails
    server-side partway through a run instead of at parse in the operator's
    editor. There is no ``convention`` member -- the server has no such value,
    and inventing one here would produce a pack that only fails once it is sent.
    """

    OWNERSHIP = "ownership"
    GOTCHA = "gotcha"
    API_CONTRACT = "api_contract"
    WORKFLOW = "workflow"
    DEPENDENCY = "dependency"
    MIGRATION = "migration"
    VALIDATION = "validation"
    SOURCE_POINTER = "source_pointer"


class Lane(StrEnum):
    """The three canon lanes, named exactly as ``agent_context_pack`` names them.

    These are the section names the server assembles and the SessionStart hook
    requests (``openbrain.config.CanonSettings.sections``). Mirrored as a closed
    set here so a typo in a pack file fails at parse rather than authoring a row
    into a lane nothing reads.
    """

    PROFILE = "profile_guidance"
    PROCESS = "process_guidance"
    REPO_FACTS = "repo_facts"


#: Lane -> the ``metadata.candidate_type`` the guidance selector discriminates on.
#: The authority is ``src/tools/agent-context-pack-guidance.ts``
#: (``GUIDANCE_CANDIDATE_TYPE``): profile_guidance is ``user_preference``,
#: process_guidance is ``process_rule``. ``repo_facts`` is absent because it is
#: NOT a lifecycle row at all -- it is an ``ob_entities`` row written by
#: ``upsert_repo_fact``, a different store with a different write surface (#445).
GUIDANCE_CANDIDATE_TYPE: dict[Lane, str] = {
    Lane.PROFILE: "user_preference",
    Lane.PROCESS: "process_rule",
}


class PackEntry(BaseModel):
    """One declared canon rule: its stable key, its lane, and its text in full.

    Attributes:
        key: The stable ``candidate_scope.key``. REQUIRED -- it is the only
            handle a later ``relegate``/``discard`` has, so an entry without one
            authors a row that can never be proven current or retired (#445).
        lane: Which of the three lanes this rule belongs to.
        text: The rule itself, whole. Never bounded, shortened, or summarised.
        source: Where the rule is cited from, so a reviewer can check it against
            live authority. Optional: a rule authored directly in the pack has no
            upstream document, and inventing a citation is worse than omitting one.
        subject: For ``repo_facts`` only -- the fact's subject, which
            ``upsert_repo_fact`` requires (``repoFactMetadata`` demands
            ``symbol`` or ``subject``). Ignored for the guidance lanes, which key
            on ``scope_key`` instead.
        fact_type: For ``repo_facts`` only -- which kind of fact this is, from
            the server's own enum. Defaults to ``gotcha``: a canon repo fact is
            by construction "the thing an agent that does not know this gets
            wrong", which is what that member means. The author overrides it when
            a fact is really an ownership, workflow, or contract statement.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    key: str = Field(min_length=1)
    lane: Lane
    text: str = Field(min_length=1)
    source: str | None = None
    subject: str | None = None
    fact_type: FactType = FactType.GOTCHA

    @field_validator("key", "text", "source", "subject")
    @classmethod
    def _no_blank(cls, value: str | None) -> str | None:
        """Reject whitespace-only fields, which are structurally unusable.

        This is the ONLY rejection: a rule that is nothing but spaces is not a
        rule. Nothing here rejects a rule for being long
        (``docs/CODING_STANDARDS.md`` section 6).
        """
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            message = "must not be blank"
            raise ValueError(message)
        return stripped

    @model_validator(mode="after")
    def _repo_facts_need_a_subject(self) -> Self:
        """A ``repo_facts`` entry must carry the subject its write path requires.

        ``upsert_repo_fact`` validates ``repoFactMetadata``, which refuses a fact
        carrying neither ``symbol`` nor ``subject``. Catching that here means an
        unusable pack fails at parse, in the operator's editor, rather than as a
        server-side validation error partway through a reconcile run.
        """
        if self.lane is Lane.REPO_FACTS and self.subject is None:
            message = "a repo_facts entry requires a subject"
            raise ValueError(message)
        return self

    @property
    def candidate_type(self) -> str | None:
        """The ``metadata.candidate_type`` for this entry's lane, if it has one.

        ``None`` for ``repo_facts``: repo facts are entities, not lifecycle
        events, so asking for their candidate type is a category error the caller
        must handle rather than a value to invent.
        """
        return GUIDANCE_CANDIDATE_TYPE.get(self.lane)


class Pack(BaseModel):
    """A pack file: its kind and its entries.

    Attributes:
        kind: What this pack declares. Only ``canon`` is accepted today; see
            :class:`PackKind`.
        entries: The declared rules, in file order. File order is preserved
            rather than sorted so a diff of the pack reads like the document the
            operator wrote.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: PackKind
    entries: tuple[PackEntry, ...]

    @model_validator(mode="after")
    def _keys_are_unique(self) -> Self:
        """Reject a pack that declares the same key twice.

        Two entries on one key is not a mergeable state: standing state per key is
        a SINGLE newest action, so a duplicate key means the pack cannot say which
        text is the rule. Failing at parse beats writing two promotes and letting
        arrival order pick a winner.
        """
        seen: set[str] = set()
        duplicates: set[str] = set()
        for entry in self.entries:
            if entry.key in seen:
                duplicates.add(entry.key)
            seen.add(entry.key)
        if duplicates:
            message = f"duplicate keys: {', '.join(sorted(duplicates))}"
            raise ValueError(message)
        return self

    def entries_for(self, lane: Lane) -> tuple[PackEntry, ...]:
        """The entries declared for one lane, in file order."""
        return tuple(entry for entry in self.entries if entry.lane is lane)

    @classmethod
    def from_toml(cls, text: str) -> Pack:
        """Parse a pack from TOML source.

        Args:
            text: The file's contents.

        Returns:
            The validated pack.

        Raises:
            tomllib.TOMLDecodeError: The file is not TOML.
            pydantic.ValidationError: The document is not a pack -- an unknown
                kind, a missing key, a duplicate key, a blank rule.

        TOML rather than YAML or JSON: it is in the standard library (``tomllib``,
        the same parser ``test_console_scripts`` already uses on
        ``pyproject.toml``), it has real multi-line strings for rule text that
        runs to a paragraph, and it does not need a dependency. "Do not hand-roll
        solved problems" cuts both ways -- neither a hand-written parser nor a new
        YAML dependency is warranted when the stdlib already answers this.
        """
        return cls.model_validate(tomllib.loads(text))

    @classmethod
    def from_path(cls, path: Path) -> Pack:
        """Parse a pack from a file on disk.

        Args:
            path: The pack file. Read whole -- a pack is a document, not a stream.

        Returns:
            The validated pack.
        """
        return cls.from_toml(path.read_text(encoding="utf-8"))
