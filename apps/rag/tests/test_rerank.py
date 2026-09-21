"""Reordering the fused candidates, and the default that changes nothing.

The measurement this exists for is in `rerank.py`'s header: on 21/09/2026 the
answering passage for A02 sat at fused **rank 11** with the cut at 8, so the
drafter never saw it and answered honestly from passages that did not contain
the answer. Reranking is the only one of the three fixes that can reach that —
a gate and a reader can refuse a wrong claim, neither can put a missing passage
on the table.

Scored by a stub rather than by a cross-encoder: the model is hundreds of
megabytes, and what is asserted here is the ordering contract, not whether
`ms-marco` reads Portuguese. The real scorer satisfies the same `Scorer`
protocol, and `test_the_real_extra_matches_the_protocol` is what keeps the stub
honest about its shape.
"""

from __future__ import annotations

from dataclasses import dataclass

from wattsteer_rag.rerank import RERANK_POOL, Reranking, rerank


@dataclass
class _Hit:
    text: str


class _Scorer:
    """Scores by a keyword, so the expected order is readable in the test."""

    def __init__(self, needle: str = "answer", *, raises: bool = False, short: bool = False) -> None:
        self.needle, self.raises, self.short = needle, raises, short
        self.seen: list[tuple[str, str]] = []

    def predict(self, pairs):
        self.seen = list(pairs)
        if self.raises:
            raise RuntimeError("scorer exploded")
        scores = [1.0 if self.needle in passage else 0.0 for _, passage in pairs]
        return scores[:-1] if self.short else scores


def _hits(n: int, answer_at: int | None = None) -> list[_Hit]:
    return [_Hit("the answer is here" if i == answer_at else f"passage {i}") for i in range(n)]


def test_it_lifts_a_passage_from_past_the_cut():
    """A02's shape: the answer at rank 11, the cut at 8. Without reranking it is
    not in the result at all; with it, it is first."""
    hits = _hits(20, answer_at=11)
    assert all("answer" not in hit.text for hit in hits[:8])

    result = rerank("q", hits, 8, scorer=_Scorer())
    assert isinstance(result, Reranking)
    assert result.provider == "scorer"
    assert len(result.hits) == 8
    assert "answer" in result.hits[0].text


def test_the_default_is_exactly_todays_behaviour():
    """The property that lets this ship turned off: no model, no scorer, no
    reordering, and the provider the contract spells `null`."""
    hits = _hits(20, answer_at=11)
    result = rerank("q", hits, 8)
    assert result.provider is None
    assert [hit.text for hit in result.hits] == [hit.text for hit in hits[:8]]


def test_a_scorer_that_fails_keeps_the_fused_order():
    """A reranker is an optional improvement and may not become an outage. Both
    shapes of failure — raising, and answering with the wrong number of scores —
    fall back to the order that already worked."""
    for scorer in (_Scorer(raises=True), _Scorer(short=True)):
        result = rerank("q", _hits(20, answer_at=11), 8, scorer=scorer)
        assert result.provider is None
        assert [hit.text for hit in result.hits] == [hit.text for hit in _hits(20, answer_at=11)[:8]]


def test_only_the_pool_is_read_and_the_tail_stays_behind_it():
    """A candidate nobody scored cannot be promoted on a score it never got."""
    scorer = _Scorer()
    hits = _hits(RERANK_POOL + 6, answer_at=RERANK_POOL + 2)
    result = rerank("q", hits, 8, scorer=scorer)
    # The scorer saw the pool and not the tail.
    assert len(scorer.seen) == RERANK_POOL
    # The answer is past the pool, so it is not rescued and nothing claims it was.
    assert all("answer" not in hit.text for hit in result.hits)


def test_ties_keep_the_order_the_fusion_gave_them():
    """`sorted` is stable, and that is load-bearing: passages a scorer cannot
    separate must not be shuffled into an order nobody can account for."""
    hits = _hits(6)
    result = rerank("q", hits, 6, scorer=_Scorer("nothing-matches"))
    assert [hit.text for hit in result.hits] == [hit.text for hit in hits]


def test_the_degenerate_inputs_do_not_crash_and_do_not_lie():
    assert rerank("q", [], 8, scorer=_Scorer()) == Reranking([], None)
    assert rerank("q", _hits(3), 0, scorer=_Scorer()) == Reranking([], None)
    # One candidate cannot be reordered, so nothing claims to have reordered it.
    single = rerank("q", _hits(1), 8, scorer=_Scorer())
    assert single.provider is None and len(single.hits) == 1


def test_it_is_off_by_default_in_the_configuration():
    """`docs/rag/decisions.md` asks for a reranker to be measured before it is
    turned on. A default model would turn it on for every deployment that
    happened to have the extra installed."""
    from wattsteer_rag.config import Settings

    assert Settings().rerank_model == ""


def test_the_real_extra_matches_the_protocol():
    """The stub above is only honest if the real thing has the same shape. Read
    off the declared extra rather than by importing it, because the suite does
    not install a few hundred megabytes to assert a method name."""
    import tomllib
    from pathlib import Path

    pyproject = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    extras = pyproject["project"]["optional-dependencies"]
    assert any("sentence-transformers" in dep for dep in extras["rerank"])
    # `CrossEncoder.predict(list[tuple[str, str]]) -> list[float]` is the call
    # `rerank` makes, and the name it imports.
    source = (Path(__file__).resolve().parents[1] / "src" / "wattsteer_rag" / "rerank.py").read_text()
    assert "from sentence_transformers import CrossEncoder" in source
    assert "engine.predict(" in source
