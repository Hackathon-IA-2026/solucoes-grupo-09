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
    from wattsteer_rag.evidence import _reviewed
    from wattsteer_rag.gate import Record

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

    from wattsteer_rag.evidence import _reviewed
    from wattsteer_rag.gate import Record
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


# ── The reader's own account of what it read, checked in code ──────────────
#
# Both shapes below were already forbidden in `VERIFY_PROMPT`'s step 1 and were
# accepted anyway (7 of 9 labelled cases, 18/09/2026). `supported` is one bit
# and arrives with no account of what was read, so a model that believed the
# programmed column answered a question about the verified one produced a
# `true` indistinguishable from a correct one. It now names the grain and the
# regime, and the disagreement is refused mechanically.


def _read(grain: str, regime: str, *, supported: bool = True) -> dict:
    return {
        "answer_from_passages": "13.107 MWmed",
        "reading": {"grain": grain, "regime": regime},
        "supported": supported,
        "reason": "A tabela traz o valor.",
    }


# I06 of `eval/questions.jsonl`, which the run of 19/09 got wrong: the IPDO
# states both columns on the same page and the answer gave the programmed one.
I06 = "Segundo o IPDO de 12/09/2023, qual foi a geração eólica verificada no Nordeste?"
# A02, which names a date and asks for a time of day rather than a day figure.
A02 = "A que horas o ONS autorizou o restabelecimento total das cargas na perturbação de 15/08/2023?"


def test_a_scheduled_figure_does_not_answer_a_question_about_a_verified_one():
    from wattsteer_rag.verify import _verdict

    supported, reason = _verdict(_read("day", "scheduled"), I06)
    assert supported is False
    assert "programado" in reason
    # The forecast regime is the same refusal: neither is a settled value.
    assert _verdict(_read("day", "forecast"), I06)[0] is False
    # And the right reading of the same question is untouched.
    assert _verdict(_read("day", "verified"), I06)[0] is True


def test_an_hourly_figure_does_not_answer_a_question_about_a_day():
    from wattsteer_rag.verify import _verdict

    supported, reason = _verdict(_read("hour", "verified"), I06)
    assert supported is False
    assert "uma hora" in reason


def test_the_grain_check_runs_in_one_direction_only():
    """A day's table stating the hour of its peak is a legitimate reading, and a
    symmetric rule would refuse it. Asserted rather than described, because the
    tempting edit is to make the rule symmetric."""
    from wattsteer_rag.verify import _verdict

    hourly = "Qual foi a geração eólica verificada na hora de maior carga de 12/09/2023?"
    assert _verdict(_read("day", "verified"), hourly)[0] is True


def test_a_question_that_names_no_regime_disables_that_half():
    """An unstated axis is not a default. Much of the corpus is about what was
    programmed, so assuming "verified" would refuse correct answers to questions
    that never asked for one."""
    from wattsteer_rag.verify import _verdict

    neutral = "Qual foi a geração eólica no Nordeste em 12/09/2023?"
    for regime in ("verified", "scheduled", "forecast", "none"):
        assert _verdict(_read("day", regime), neutral)[0] is True


def test_a_date_with_an_hour_cue_is_not_a_question_about_the_day():
    """A02 names a date and asks for a time of day. Reading it as a day question
    would refuse the one answer it has."""
    from wattsteer_rag.verify import asked_reading

    assert asked_reading(A02)[0] is None
    assert asked_reading(I06)[0] == "day"


def test_a_reader_that_reports_no_reading_is_exactly_as_strict_as_before():
    """The property that lets this ship without a measured run behind it: the
    new field can only take claims away. A model too old or too small to report
    it leaves every existing verdict unchanged."""
    from wattsteer_rag.verify import _verdict

    without = {"answer_from_passages": "x", "supported": True, "reason": "ok"}
    assert _verdict(without, I06) == (True, "ok")
    assert _verdict({**without, "reading": None}, I06)[0] is True
    assert _verdict({**without, "reading": "day"}, I06)[0] is True
    assert _verdict({**without, "reading": {}}, I06)[0] is True
    # A refusal is still a refusal, and keeps the reader's own reason rather
    # than being restated as a mismatch.
    refused = {**without, "supported": False, "reading": {"grain": "hour", "regime": "scheduled"}}
    assert _verdict(refused, I06) == (False, "ok")


def test_the_prompt_asks_for_the_reading_it_is_checked_on():
    """The two halves have to agree: a check on a field the prompt never asks
    for would be a check that never fires."""
    from wattsteer_rag.verify import VERIFY_PROMPT

    assert '"reading"' in VERIFY_PROMPT
    for token in ("hour", "day", "month", "period", "verified", "scheduled", "forecast"):
        assert token in VERIFY_PROMPT
    # And it must ask for what the passage says, not for what the question
    # wanted — a reader that echoes the question cannot disagree with it.
    # Whitespace-insensitive: the instruction wraps, and a test pinned to where
    # it wraps would break on a reflow rather than on a changed rule.
    assert "not what the question asked for" in " ".join(VERIFY_PROMPT.split())


def test_a_comparison_asks_for_both_regimes():
    """Measured on 23/09/2026, in questions written blind to this code: "A usina
    solar Futura entregou o que estava programado?" was answered with 115,37
    delivered against 155,50 scheduled, -25,81%, the expected answer, and refused
    as "the question asks for the scheduled value". Naming one side of a
    comparison asks for both; a question about one side still names it."""
    from wattsteer_rag.verify import asked_reading

    assert asked_reading("A usina solar Futura entregou o que estava programado em 15/09/2026?")[1] is None
    assert (
        asked_reading("Às 10h do dia 13/09/2026, a carga do Sul ficou quanto abaixo da previsão?")[1] is None
    )
    assert asked_reading("Qual foi a carga programada do Sul em 13/09/2026?")[1] == "scheduled"
    assert asked_reading("Qual foi a geração eólica verificada no Nordeste em 12/09/2023?")[1] == "verified"
