"""Deterministic, bounded per-turn concept/entity key extraction (OB #332).

At the current-turn recall-request boundary the caller has one thing the durable
brain does not: the exact text of *this* turn. This module turns that text into a
small, normalized, bounded set of salient **entity** and **concept** keys that can
drive recall for the turn.

This is currently a standalone Python client convenience. A TypeScript
counterpart is future work tracked for the later client phase; no existing
TypeScript module implements this pass today, so nothing here mirrors an
existing counterpart.

Design constraints (issue #332, REFLEX-1):

- Deterministic and zero-network. The same input always yields the same keys; no
  model, provider, or network call participates. This is a pure tokenizer +
  normalizer over the caller-supplied string.
- Bounded. A configured maximum caps the number of emitted keys per category, so
  adversarial or verbose input cannot inflate an unbounded key list.
- Normalized and stable. Equivalent spellings collapse to one key
  (case-insensitive, first spelling wins), so "the API" and "API" and "api"
  produce one concept key, and repeated entities are counted once.
- Never persisted. These keys drive recall for the current turn only. Nothing
  here writes durable memory; the caller must not persist the returned keys as
  memories.
- Content-free telemetry. ``TurnConcepts.telemetry()`` emits only counts and
  category names -- never the raw turn text and never an extracted key -- so an
  observability sink can record extraction behavior without leaking private
  turn content.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# Default cap on emitted keys *per category* (entities, concepts). Applied AFTER
# normalize + dedupe so the emitted list is always bounded regardless of input
# length. Kept modest: these keys drive a single turn's recall, not a corpus.
DEFAULT_MAX_KEYS = 16

# A token must be at least this many characters to be considered a concept key.
# Short function words ("a", "to", "is") carry no recall signal and are dropped
# below this threshold; entity keys (proper-noun-shaped) bypass it so a short
# capitalized name like "OB" or "AI" still surfaces as an entity.
MIN_CONCEPT_LENGTH = 3

# Hard cap on the character length of any single normalized key, so one giant
# unbroken token cannot smuggle a large substring of the turn into a key.
MAX_KEY_LENGTH = 64

# Tokenizer: a "word" is a run of Unicode letters/digits, optionally joined
# internally by a single ``-``, ``_``, ``.`` or ``/`` (so ``open-brain``,
# ``agent_memory``, ``v1.2`` and ``src/tokenizer`` survive as one token). The
# atom class ``[^\W_]`` is the Unicode word set minus underscore -- i.e. any
# letter or digit in any script (accented Latin ``café``, Cyrillic ``Москва``,
# CJK ``日本語``, digits) -- so tokenization is not ASCII-only. ``re.UNICODE`` is
# the default for ``str`` patterns; it is set explicitly here as documentation.
#
# Because every atom must contain at least one letter/digit, a run of pure
# punctuation, a bare separator, or a standalone combining mark can never form a
# token: punctuation-only and combining-mark garbage keys are impossible by
# construction. Anchored to letter/digit runs; anything between tokens is a
# separator, never part of a key.
_TOKEN_RE = re.compile(r"[^\W_]+(?:[-_./][^\W_]+)*", re.UNICODE)

# Entity classification is casing-independent so equivalent inputs are stable: a
# token is an entity ONLY when it carries an internal separator (``-``, ``_``,
# ``.`` or ``/``) -- the identifier-shaped tokens like ``open-brain``,
# ``agent_memory``, ``v1.2`` or ``src/tokenizer``. Leading/mixed *case* is
# deliberately NOT used as an entity signal: "API"/"api" or sentence-initial
# capitalization would otherwise flip a key's category between equivalent turns,
# which breaks normalization stability. Ordinary words -- capitalized or not --
# are concept keys, always lowercased. The separator survives casefold, so
# "Open-Brain" and "open-brain" classify identically and normalize to one key.
_SEPARATOR_RE = re.compile(r"[-_./]")

# Deterministic, tiny stopword set. Kept intentionally small and closed: it only
# removes the highest-frequency English function words that are pure noise as
# recall keys. It is NOT a semantic filter and never touches entity-shaped
# tokens. Frozen so the set is stable across processes and releases.
_STOPWORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "are",
        "but",
        "not",
        "you",
        "with",
        "this",
        "that",
        "have",
        "from",
        "they",
        "will",
        "would",
        "there",
        "their",
        "what",
        "about",
        "which",
        "when",
        "your",
        "were",
        "been",
        "than",
        "then",
        "them",
        "these",
        "some",
        "into",
        "could",
        "should",
        "please",
        "just",
        "like",
        "how",
        "can",
        "get",
        "got",
    }
)


@dataclass(frozen=True)
class TurnConcepts:
    """Bounded normalized keys extracted from one turn.

    ``entities`` are identifier-shaped keys -- tokens carrying an internal
    separator (``open-brain``, ``agent_memory``, ``src/tokenizer``, ``v1.2``).
    ``concepts`` are ordinary content keys. Both are lowercased (so equivalent
    inputs are stable regardless of casing), order-preserving, internally
    deduped, and capped at ``max_keys``.

    ``truncated`` is True when either category hit ``max_keys`` and additional
    distinct keys were dropped, so a caller can tell a bounded emission from an
    exhaustive one. ``max_keys`` records the cap that produced this result.

    Nothing here is durable memory. These keys drive the current turn's recall
    and must not be persisted as memories.
    """

    entities: tuple[str, ...] = ()
    concepts: tuple[str, ...] = ()
    truncated: bool = False
    max_keys: int = DEFAULT_MAX_KEYS
    _dropped_entities: int = field(default=0, repr=False)
    _dropped_concepts: int = field(default=0, repr=False)

    @property
    def keys(self) -> tuple[str, ...]:
        """Entities followed by concepts as a single ordered key list."""
        return self.entities + self.concepts

    def telemetry(self) -> dict[str, int | bool | list[str]]:
        """Content-free observability envelope.

        Emits ONLY counts, category names, and the configured bound -- never the
        raw turn text and never an extracted key. Safe to hand to any logger or
        metrics sink without leaking private turn content.
        """
        return {
            "categories": ["entities", "concepts"],
            "entity_count": len(self.entities),
            "concept_count": len(self.concepts),
            "key_count": len(self.entities) + len(self.concepts),
            "dropped_entities": self._dropped_entities,
            "dropped_concepts": self._dropped_concepts,
            "truncated": self.truncated,
            "max_keys": self.max_keys,
        }


def verbatim_tokens(text: str) -> frozenset[str]:
    """Return the set of raw (Unicode-normalized, bounded) tokens in ``text``.

    Same tokenizer, Unicode NFC normalization, and length bound as
    ``extract_turn_concepts`` but WITHOUT casefolding. A caller uses this to
    decide whether an extracted key -- which is always casefolded -- is already
    represented in the original text in its exact normalized form. A query token
    like ``API`` or ``Open-Brain`` is not a verbatim match for the key
    ``api``/``open-brain``, so the normalized key is a genuinely new
    representation worth surfacing. NFC normalization means an accented token
    written in decomposed form (``e`` + combining acute) matches the same token
    written composed (``é``). Deterministic and zero-network.
    """
    if not text:
        return frozenset()
    return frozenset(
        _verbatim_key(match.group(0)) for match in _TOKEN_RE.finditer(_nfc(text))
    )


def _nfc(text: str) -> str:
    """NFC-normalize the whole input BEFORE tokenizing.

    Combining marks (U+0301 and friends) are not word characters, so the
    tokenizer would otherwise break an atom at a base letter and silently drop a
    trailing combining mark -- turning decomposed ``cafe`` + combining acute into
    the key ``cafe`` instead of ``café``. Composing the text first means the
    accented letter is a single word code point that survives tokenization, so
    composed and decomposed spellings yield the same key and no bare combining
    mark can leak into a key or a derived recall fragment.
    """
    return unicodedata.normalize("NFC", text)


def _is_entity_token(token: str) -> bool:
    return bool(_SEPARATOR_RE.search(token))


def _verbatim_key(token: str) -> str:
    """Length-bound a token, preserving its casing.

    The input text is already NFC-normalized before tokenization (see ``_nfc``),
    so bounding is all that remains; it is applied last so ``MAX_KEY_LENGTH``
    counts code points of the emitted key.
    """
    return _bound_key(token)


def _casefold_key(token: str) -> str:
    """Casefold and length-bound a token.

    The input text is already NFC-normalized before tokenization (see ``_nfc``),
    giving stable caseless equivalence across composed and decomposed accented
    spellings. Casefold output is re-composed to NFC so casing folds that emit
    combining sequences still yield a stable, composed key; bounding is applied
    last so ``MAX_KEY_LENGTH`` counts code points of the final normalized key.
    """
    return _bound_key(unicodedata.normalize("NFC", token.casefold()))


def _bound_key(token: str) -> str:
    return token if len(token) <= MAX_KEY_LENGTH else token[:MAX_KEY_LENGTH]


def extract_turn_concepts(
    text: str,
    *,
    max_keys: int = DEFAULT_MAX_KEYS,
) -> TurnConcepts:
    """Extract bounded, normalized entity/concept keys from one turn of text.

    Deterministic and zero-network: the same ``text`` always yields the same
    result. Entities are identifier-shaped tokens (an internal
    ``-``/``_``/``.``/``/`` separator); everything else is a concept. Every key
    is lowercased. Both categories are:

    - deduped case-insensitively (so repeated entities count once and equivalent
      spellings -- "API"/"api", "Open-Brain"/"open-brain" -- collapse to one key),
    - order-preserving (first occurrence order in the turn),
    - capped at ``max_keys`` per category, with any further distinct keys dropped
      and ``truncated`` set.

    Empty or whitespace-only input yields an empty result (no keys, not
    truncated). ``max_keys`` must be >= 1.
    """
    if max_keys < 1:
        raise ValueError("max_keys must be >= 1")

    entities: list[str] = []
    concepts: list[str] = []
    seen_entities: set[str] = set()
    seen_concepts: set[str] = set()
    dropped_entities = 0
    dropped_concepts = 0

    if text:
        for match in _TOKEN_RE.finditer(_nfc(text)):
            lowered = _casefold_key(match.group(0))
            if _is_entity_token(lowered):
                # Entity (identifier-shaped) keys are lowercased and deduped, so
                # "Open-Brain" and "open-brain" collapse to one stable key.
                if lowered in seen_entities:
                    continue
                if len(entities) >= max_keys:
                    dropped_entities += 1
                    continue
                seen_entities.add(lowered)
                entities.append(lowered)
                continue

            # Concept tokens: drop stopwords and sub-threshold tokens. Pure-digit
            # tokens carry no concept signal on their own and are dropped here;
            # identifier-shaped digit tokens (e.g. "v1", "sha256") are letters+
            # digits and survive.
            if len(lowered) < MIN_CONCEPT_LENGTH:
                continue
            if lowered in _STOPWORDS:
                continue
            if lowered.isdigit():
                continue
            if lowered in seen_concepts:
                continue
            if len(concepts) >= max_keys:
                dropped_concepts += 1
                continue
            seen_concepts.add(lowered)
            concepts.append(lowered)

    return TurnConcepts(
        entities=tuple(entities),
        concepts=tuple(concepts),
        truncated=dropped_entities > 0 or dropped_concepts > 0,
        max_keys=max_keys,
        _dropped_entities=dropped_entities,
        _dropped_concepts=dropped_concepts,
    )
