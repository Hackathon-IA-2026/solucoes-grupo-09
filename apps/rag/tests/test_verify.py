"""The second reader of every accepted claim."""

from __future__ import annotations


class _Reader:
    """A stand-in for the gateway's `verify` task: answers from a script, or is out of quota."""

    def __init__(self, answers: list | None = None) -> None:
        self.answers = list(answers or [])
        self.asked: list[str] = []

    async def run(self, task: str, **kwargs):
        from types import SimpleNamespace

        from wattsteer_rag.gateway.router import QuotaExhausted

        assert task == "verify"
        self.asked.append(kwargs["messages"][1]["content"])
        if not self.answers:
            raise QuotaExhausted("verify", 0.0)
        return SimpleNamespace(value=self.answers.pop(0))


LAPA_CLAIM = {
    "claim": "A produção solar verificada do CONJUNTO FOTOVOLTAICO LAPA em 07/09/2026 foi de 11,802 MWmed.",
    "supports": "NONE",
    "citations": [
        {
            "chunk_id": "c1",
            "quote": "| Solar | 11.576 | 11.802 | 16,61% | CONJUNTO FOTOVOLTAICO LAPA",
            "external_id": "BDO 2026-09-07 01",
            "locator": {"page": 1, "section": None},
        }
    ],
}


async def test_a_claim_the_second_reader_does_not_find_in_its_quote_is_refused():
    """Measured on 2026-09-18: LAPA's solar output was answered with the SIN's
    11,802, and every mechanical gate passed, because the number was in the
    quote. Only reading the row tells them apart."""
    from wattsteer_rag.evidence import Record, _reviewed

    reader = _Reader([{"supported": False, "reason": "11,802 é o total solar do SIN, não a usina LAPA."}])
    generation: dict = {}
    failures: list = []
    record = Record(
        question="Qual foi a produção solar verificada do CONJUNTO FOTOVOLTAICO LAPA em 07/09/2026?"
    )
    kept = await _reviewed(reader, record, [LAPA_CLAIM], 1, generation, failures)
    assert kept == []
    assert [failure.code for failure in failures] == ["quote_does_not_state_claim"]
    assert generation["rejected"][0]["failures"][0]["detail"].startswith("11,802")
    # The reader sees the question, the claim and the quote with its document, nothing else.
    assert "LAPA" in reader.asked[0] and "[BDO 2026-09-07 01]" in reader.asked[0]

    supported = _Reader([{"supported": True, "reason": "A linha da usina traz 9,39."}])
    assert await _reviewed(supported, record, [LAPA_CLAIM], 1, {}, []) == [LAPA_CLAIM]


async def test_no_reader_means_no_claim():
    """Out of quota, or an answer out of shape, is not a yes: the service's
    failure mode is silence."""
    from wattsteer_rag.evidence import Record, _reviewed

    failures: list = []
    assert await _reviewed(_Reader([]), Record(question="q"), [LAPA_CLAIM], 1, {}, failures) == []
    assert "reviewer unavailable" in failures[0].detail
    shapeless = _Reader([{"supported": "sim"}])
    assert await _reviewed(shapeless, Record(question="q"), [LAPA_CLAIM], 1, {}, []) == []
