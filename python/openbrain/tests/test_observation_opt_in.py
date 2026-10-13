"""An empty ``OPENBRAIN_OBSERVATION_ENABLED`` loads as unset (issue 682).

The deployed ``openbrain-hook-env`` wrapper builds the hook environment with
``env -i VAR="${VAR:-}"``, so a host whose env file omits the observation
opt-in hands the hook an EMPTY STRING. Pydantic's bool parser rejects ``""``,
``loaded_observation()`` swallows the raise, and the Langfuse lane goes dark
with no error anywhere. ``allow_insecure_http`` already binds the shared
``_empty_opt_in_means_unset`` helper for exactly this shape; ``enabled`` did
not.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from openbrain.config import load_observation_settings


@pytest.mark.parametrize("blank", ["", "   "], ids=["empty", "whitespace"])
def test_an_empty_observation_opt_in_loads_with_observation_off(blank: str) -> None:
    """A blank opt-in is unset: loading succeeds and observation stays off."""
    settings = load_observation_settings({"OPENBRAIN_OBSERVATION_ENABLED": blank})

    assert settings.enabled is False


@pytest.mark.parametrize("enabling", ["1", "true"], ids=["one", "true"])
def test_a_real_observation_opt_in_still_enables(enabling: str) -> None:
    """Empty-means-unset does not blunt the values that mean yes."""
    settings = load_observation_settings({"OPENBRAIN_OBSERVATION_ENABLED": enabling})

    assert settings.enabled is True


def test_a_garbage_observation_opt_in_is_still_rejected() -> None:
    """Blank is unset; nonsense is still an error."""
    with pytest.raises(ValidationError):
        load_observation_settings({"OPENBRAIN_OBSERVATION_ENABLED": "maybe"})
