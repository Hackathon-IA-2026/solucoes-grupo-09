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

    reader = _Reader(
        [
            {
                "answer_from_passages": None,
                "supported": False,
                "reason": "11,802 é o total solar do SIN, não a usina LAPA.",
            }
        ]
    )
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

    supported = _Reader(
        [{"answer_from_passages": "9,39 MWmed", "supported": True, "reason": "A linha da usina traz 9,39."}]
    )
    assert await _reviewed(supported, record, [LAPA_CLAIM], 1, {}, []) == [LAPA_CLAIM]


async def test_no_reader_means_no_claim():
    """Out of quota is not a yes, and not a "no" either: it stops the builder
    (review of #24, retries were spending generation quota on drafts nobody
    could read). An answer missing its own reading is refused."""
    import pytest

    from wattsteer_rag.evidence import Record, _reviewed
    from wattsteer_rag.verify import ReaderUnavailable

    with pytest.raises(ReaderUnavailable):
        await _reviewed(_Reader([]), Record(question="q"), [LAPA_CLAIM], 1, {}, [])
    for shapeless in (
        {"supported": "sim"},
        {"supported": True},
        {"supported": True, "answer_from_passages": "x"},
    ):
        assert await _reviewed(_Reader([shapeless]), Record(question="q"), [LAPA_CLAIM], 1, {}, []) == []


def test_the_gateway_config_must_declare_the_claim_reader():
    """Review of #24: `verify` is called on every draft, but the config schema
    did not require it, so a config without it validated and then failed at
    run time with a KeyError instead of the documented refusal."""
    import copy
    import json
    from pathlib import Path

    import jsonschema
    import pytest
    import yaml

    docs = Path(__file__).resolve().parents[3] / "docs" / "rag"
    schema = json.loads((docs / "llm-gateway-config.schema.json").read_text())
    config = yaml.safe_load((docs / "gateway.yaml").read_text())
    jsonschema.validate(config, schema)
    without = copy.deepcopy(config)
    del without["tasks"]["verify"]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(without, schema)
