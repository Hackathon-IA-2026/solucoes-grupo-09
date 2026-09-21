"""Reorder the fused candidates by reading them against the question.

## Why this exists, measured rather than assumed

`docs/rag/decisions.md` left a reranker optional and said the RRF order would
be used until one measured better. On 21/09/2026 the goldset said what it costs.
Retrieval fuses 40 vector and 40 text candidates and hands the drafter the top
**8**, and for two of the three wrong answers the passage that holds the answer
never reaches it:

- **A02** ("A que horas o ONS autorizou o restabelecimento total…") — the
  answering chunk is at fused **rank 11**. It is the 4th nearest by vector and
  matches no text query, so RRF, which rewards agreement between the two arms,
  ranks eleven other pages above it. Three places past the cut.
- **A01** ("Quanta carga foi interrompida no SIN…") — the sentence
  "ocorreu a interrupção de aproximadamente 23.368 MW de cargas do SIN" is on
  page 15 of a 572-page report, is chunked, embedded and not superseded, and
  does not appear in the 80 candidates at all.

Neither is a gate failure or a reader failure: the drafter answered honestly
from what it was given, and what it was given did not contain the answer. No
amount of tightening `gate.py` or `verify.py` can fix a passage that is not on
the table, which is why this is the third fix and not another rule.

## What it does, and what it deliberately does not

A cross-encoder scores (question, passage) **jointly**, which is what RRF
cannot do: RRF only knows each arm's rank, so a passage that one arm ranks 4th
and the other does not return at all is punished for the disagreement rather
than read. Reranking a **wider pool** than the cut and then taking the top
`top_hits` is the whole mechanism — a candidate at rank 11 can win, and one at
rank 1 can lose.

It never widens what is *eligible*. The filters in `retrieve.search` — the
superseded revision, the table of contents, the daily bulletin of another day,
the operating instruction the record does not name — are correctness rules and
they run before this. Reordering happens strictly inside what those allowed.

## Off unless it is installed and asked for

`sentence-transformers` is an optional extra and the model is a few hundred
megabytes, so the default is exactly today's behaviour: {@link rerank} returns
the fused order untouched and reports `None`, which is the `rerank_provider:
null` the evidence contract already describes. A deployment that has not
installed it, or has not set `WATTSTEER_RAG_RERANK_MODEL`, is not silently
running a different retrieval from the one that was measured.

The import is deferred to the first call rather than done at module scope, so
importing `wattsteer_rag` stays cheap for the API process, which never reranks.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

log = logging.getLogger(__name__)


class Scorer(Protocol):
    """What a cross-encoder has to do. Narrow on purpose: the tests supply their
    own rather than downloading a model, and the real one satisfies it."""

    def predict(self, pairs: list[tuple[str, str]]) -> list[float]: ...


@dataclass(frozen=True)
class Reranking:
    """The new order and who produced it.

    `provider` is `None` when nothing reranked, which is the state the evidence
    contract spells `rerank_provider: null` — and the order is then the fused
    one, unchanged, rather than an order nobody can account for.
    """

    hits: list
    provider: str | None


#: How many fused candidates are read before the cut.
#:
#: 24 rather than all 80: a cross-encoder costs a forward pass per candidate, and
#: the measured miss is at rank 11. Reading three times the cut covers it with
#: room, and reading everything would spend most of the time on pages no arm
#: ranked. A01's chunk is outside even this, and is a retrieval-recall problem
#: that reranking cannot reach — said here so the next reader does not raise this
#: number expecting A01 to move.
RERANK_POOL = 24

_scorer: Scorer | None = None
_loaded_model: str | None = None


def _load(model: str) -> Scorer | None:
    """The cross-encoder, or `None` when the extra is not installed.

    Cached across calls: the model is hundreds of megabytes and loading it per
    question would cost more than the reranking saves. A failure to load is
    logged once and then behaves as "not installed" for the rest of the process,
    because a reranker that raises mid-run would turn an optional improvement
    into an outage.
    """
    global _scorer, _loaded_model
    if _loaded_model == model:
        return _scorer
    _loaded_model = model
    try:
        from sentence_transformers import CrossEncoder
    except ImportError:
        log.info("rerank: sentence-transformers is not installed; keeping the RRF order")
        _scorer = None
        return None
    try:
        _scorer = CrossEncoder(model)
    except Exception as exc:  # noqa: BLE001 - any load failure is the same answer
        log.warning("rerank: %s could not be loaded (%s); keeping the RRF order", model, exc)
        _scorer = None
    return _scorer


def rerank(
    question: str, hits: list, limit: int, *, model: str = "", scorer: Scorer | None = None
) -> Reranking:
    """Read the top {@link RERANK_POOL} candidates against the question, and cut to `limit`.

    Returns the fused order untouched, with `provider: None`, whenever there is
    nothing to rerank with or nothing to reorder — an empty `model`, an
    uninstalled extra, one candidate, or a scorer that raised. Every one of
    those is today's behaviour, which is the property that lets this ship
    disabled and be turned on by a measurement rather than by a preference.

    The tail beyond the pool keeps its fused order and stays behind the reranked
    head: it was not read, so it cannot be promoted on a score it never got.
    """
    if not hits or limit <= 0:
        return Reranking(hits[:limit] if limit > 0 else [], None)
    engine = scorer if scorer is not None else (_load(model) if model else None)
    if engine is None or len(hits) <= 1:
        return Reranking(hits[:limit], None)

    head, tail = hits[:RERANK_POOL], hits[RERANK_POOL:]
    try:
        scores = engine.predict([(question, hit.text) for hit in head])
    except Exception as exc:  # noqa: BLE001 - a reranker may not fail a request
        log.warning("rerank: scoring failed (%s); keeping the RRF order", exc)
        return Reranking(hits[:limit], None)
    if len(scores) != len(head):
        log.warning("rerank: scorer returned %d scores for %d passages", len(scores), len(head))
        return Reranking(hits[:limit], None)

    # `sorted` is stable, so candidates the scorer cannot separate keep the order
    # the fusion gave them rather than an arbitrary one.
    ordered = [
        hit for _, hit in sorted(zip(scores, head, strict=True), key=lambda pair: pair[0], reverse=True)
    ]
    return Reranking((ordered + tail)[:limit], model or "scorer")
