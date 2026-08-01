"""Models for the directory watcher: a unit of work and a record of what happened.

The watch app processes files that appear in a directory. These two types
separate the *intent* to process a file from the *record* of having processed
it, for the same reason the check models separate observation from judgement: a
job that carries its own outcome cannot represent "attempted twice with
different results", which is precisely the case a manifest exists to describe.

See Also:
    - exemplar.apps.watch.processor: consumes WatchJob, produces WatchOutcome
    - exemplar.models.check: the same immutable/mutable split, in another domain
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

from exemplar.utils.datetime_helpers import utc_now


class WatchOutcome(StrEnum):
    """What happened to one file.

    SKIPPED and FAILED are distinct, and the distinction is load-bearing: a
    skipped file was correctly ignored (wrong suffix, already processed), while
    a failed file was one we should have handled and could not. Collapsing them
    means a genuine failure is indistinguishable from routine filtering, and
    nobody notices the processor has been broken for a week.
    """

    PROCESSED = "processed"
    SKIPPED = "skipped"
    FAILED = "failed"


class WatchJob(BaseModel):
    """One file, claimed for processing.

    Frozen: a job describes a file as it was when discovered. If the file
    changes underneath us, that is a new job, not an edit to this one -- and
    ``size_bytes`` recorded at discovery is what makes that detectable.
    """

    model_config = ConfigDict(frozen=True)

    path: Path
    discovered_at: datetime = Field(default_factory=utc_now)

    #: Size at discovery. Compared against the size at read time to detect a
    #: file still being written -- the classic watcher bug, where a partially
    #: copied file is processed as though complete.
    size_bytes: int = Field(ge=0)

    @field_validator("path")
    @classmethod
    def _must_be_absolute(cls, value: Path) -> Path:
        """Require an absolute path.

        A relative path is interpreted against the process's working directory,
        which is not a property of the job and can differ between the code that
        created it and the code that reads it. Absolute paths make a job
        meaningful regardless of where it is handled.
        """
        if not value.is_absolute():
            msg = (
                f"job path must be absolute, got {value}. "
                f"ACTION REQUIRED: resolve it before constructing the job -- "
                f"a relative path means something different to each caller."
            )
            raise ValueError(msg)
        return value


class WatchManifest(BaseModel):
    """Record of one processing run over one batch of files.

    Written to disk after each batch so a run is auditable after the fact:
    what was seen, what was done, what failed and why.

    NOT frozen -- it accumulates as the batch is processed, then is written
    once at the end.
    """

    started_at: datetime = Field(default_factory=utc_now)
    finished_at: datetime | None = None

    #: Outcome per file, keyed by the file's name rather than its full path.
    #: The directory is a property of the run, so repeating it on every key is
    #: noise that also makes the manifest non-portable between machines.
    outcomes: dict[str, WatchOutcome] = Field(default_factory=dict)

    #: Error text for entries whose outcome is FAILED, keyed the same way. A
    #: separate mapping rather than a field on the outcome so the common case
    #: (success) carries no empty error field.
    errors: dict[str, str] = Field(default_factory=dict)

    @property
    def processed_count(self) -> int:
        """How many files were successfully processed."""
        return sum(1 for o in self.outcomes.values() if o is WatchOutcome.PROCESSED)

    @property
    def failed_count(self) -> int:
        """How many files failed.

        The number that matters operationally: nonzero means something needs
        attention, whereas a skip count is routine.
        """
        return sum(1 for o in self.outcomes.values() if o is WatchOutcome.FAILED)
