"""The gates are the product. If they can be talked past, nothing else matters."""

from __future__ import annotations

from datetime import UTC, datetime

from wattsteer_rag.evidence import (
    causal_hits,
    check_claim,
    flatten_for_match,
    has_substance,
    numbers_in,
    question_for,
)
from wattsteer_rag.retrieve import Hit, codes_in, to_or_tsquery

CHUNK_TEXT = (
    "| Passo | Coordenação | Procedimento |\n| --- | --- | --- |\n"
    "| 1 | COSR-NE | Controlar a tensão de 230 kV da SE Senhor do Bonfim II, "
    "de acordo com os limites abaixo: |\n| | | PSNB ≤ 260 MW | VSNB ≥ 230 kV |"
)


def hit(text: str = CHUNK_TEXT, locator: dict | None = None) -> Hit:
    return Hit(
        chunk_id="c1",
        document_id="d1",
        text=text,
        locator=locator if locator is not None else {"page": 6, "section": "5.1", "kind": "body"},
        section_path="5.1",
        source="INSTRUCAO_OPERACAO",
        title="IO-ON.NE.2SO",
        url="https://ons.org.br/io.pdf",
        external_id="IO-ON.NE.2SO",
        revision="Rev.146",
        published_at=datetime(2026, 9, 9, tzinfo=UTC),
        sha256="f" * 64,
        score=0.1,
    )


def claim_with(
    quote: str,
    claim: str = "O documento estabelece VSNB maior ou igual a 230 kV para PSNB de ate 260 MW",
) -> dict:
    return {
        "claim": claim,
        "supports": "CNF",
        "confidence": "high",
        "citations": [{"chunk_id": "c1", "quote": quote}],
    }


def test_quote_must_exist_in_the_chunk():
    accepted, failures = check_claim(
        claim_with("Controlar a corrente de 500 kV da SE Inventada II, conforme anexo"),
        {"c1": hit()},
    )
    assert accepted is None
    assert any(failure.code == "quote_not_in_chunk" for failure in failures)


def test_table_syntax_does_not_break_a_real_quote():
    quote = "Controlar a tensão de 230 kV da SE Senhor do Bonfim II, de acordo com os limites abaixo"
    accepted, failures = check_claim(
        claim_with(quote, "O documento manda controlar a tensão de 230 kV da SE Senhor do Bonfim II"),
        {"c1": hit()},
    )
    assert accepted is not None, failures
    assert accepted["citations"][0]["locator"]["page"] == 6


def test_a_number_the_quote_does_not_carry_is_refused():
    quote = "Controlar a tensão de 230 kV da SE Senhor do Bonfim II, de acordo com os limites abaixo"
    accepted, failures = check_claim(
        claim_with(quote, "O limite e de 999 MW na SE Senhor do Bonfim II conforme o documento"),
        {"c1": hit()},
    )
    assert accepted is None
    assert any(failure.code == "number_not_in_quote" for failure in failures)


def test_causal_language_is_refused():
    quote = "Controlar a tensão de 230 kV da SE Senhor do Bonfim II, de acordo com os limites abaixo"
    accepted, failures = check_claim(
        claim_with(quote, "A restrição foi causada por limitação na SE Senhor do Bonfim II"),
        {"c1": hit()},
    )
    assert accepted is None
    assert any(failure.code == "causal_vocabulary" for failure in failures)


def test_a_heading_alone_is_not_evidence():
    accepted, failures = check_claim(
        claim_with("5.1. Limitação do Fluxo Senhor do Bonfim II", "O documento traz a seção de limitação"),
        {"c1": hit(text="5.1. Limitação do Fluxo Senhor do Bonfim II")},
    )
    assert accepted is None
    assert any(failure.code == "quote_without_substance" for failure in failures)


def test_a_citation_with_no_locator_is_refused():
    quote = "Controlar a tensão de 230 kV da SE Senhor do Bonfim II, de acordo com os limites abaixo"
    accepted, failures = check_claim(claim_with(quote), {"c1": hit(locator={})})
    assert accepted is None
    assert any(failure.code == "locator_missing" for failure in failures)


def test_rel_never_claims_high_confidence():
    """No public intervention schedule exists, so REL cannot be settled by a document."""
    quote = "Controlar a tensão de 230 kV da SE Senhor do Bonfim II, de acordo com os limites abaixo"
    item = claim_with(quote, "O documento registra o procedimento de controle na SE Senhor do Bonfim II")
    item["supports"] = "REL"
    accepted, _ = check_claim(item, {"c1": hit()})
    assert accepted is not None
    assert accepted["confidence"] == "medium"
    assert accepted["evidence_weight"] == 0.8


def test_flatten_keeps_word_order():
    assert "senhor do bonfim" in flatten_for_match(CHUNK_TEXT)
    assert "|" not in flatten_for_match(CHUNK_TEXT)


def test_numbers_and_codes_are_found():
    assert "260" in numbers_in("PSNB ≤ 260 MW")
    assert codes_in("LIMITAÇÃO - IO-ON.NE.2SO e SGI N° 46.066-26") == [
        "IO-ON.NE.2SO",
        "SGI N° 46.066-26",
    ]


def test_causal_hits_allow_the_record_wording():
    assert causal_hits("o documento registra intervenção programada") == []
    assert causal_hits("a restrição foi causada por manutenção") == ["causada por"]


def test_has_substance():
    assert not has_substance("5.1. Limitação do Fluxo")
    assert has_substance("PSNB ≤ 260 MW e VSNB ≥ 230 kV")


def test_question_carries_the_cited_codes():
    question = question_for("NE", "2026-09-14", "CNF", "Controle de inequação: LIMITE - IO-ON.NE.2SO")
    assert "IO-ON.NE.2SO" in question
    assert "CNF" in question


def test_or_tsquery_keeps_codes_and_drops_noise():
    query = to_or_tsquery("Controle de inequação: LIMITAÇÃO DO FLUXO - IO-ON.NE.2SO")
    assert "IO-ON.NE.2SO" in query
    assert " | " in query
    assert "que" not in query.split(" | ")


TABLE_CHUNK = (
    "| 1 | COSR-NE | Controlar a tensão de 230 kV da SE Senhor do Bonfim II, de acordo com os limites abaixo: "
    "| - Evitar colapso de tensão |\n| | | PSNB | Tensão | QSNB |\n| | | PSNB ≤ 260 MW | VSNB ≥ 230 kV | - |"
)


def test_a_table_citation_may_skip_cells_but_not_reorder_them():
    """The row that names the control and the row that carries the limit are the
    citation a person would point at, and they are never adjacent in a table."""
    quote = "Controlar a tensão de 230 kV da SE Senhor do Bonfim II, de acordo com os limites abaixo: | PSNB ≤ 260 MW | VSNB ≥ 230 kV"
    accepted, failures = check_claim(
        claim_with(quote, "O documento estabelece VSNB ≥ 230 kV para PSNB ≤ 260 MW"),
        {"c1": hit(text=TABLE_CHUNK, locator={"page": 6, "section": "5.1", "table": "table"})},
    )
    assert accepted is not None, failures
    assert accepted["citations"][0]["assembled"] is True


def test_reordering_the_cells_is_still_refused():
    quote = "PSNB ≤ 260 MW | VSNB ≥ 230 kV | Controlar a tensão de 230 kV da SE Senhor do Bonfim II"
    accepted, failures = check_claim(
        claim_with(quote, "O documento estabelece o controle de tensão na SE Senhor do Bonfim II"),
        {"c1": hit(text=TABLE_CHUNK, locator={"page": 6, "table": "table"})},
    )
    assert accepted is None
    assert any(failure.code == "quote_not_in_chunk" for failure in failures)


def test_prose_still_requires_a_contiguous_span():
    prose = "O procedimento estabelece o controle de tensão na área. Outra frase qualquer no meio. E o limite de 260 MW."
    quote = "O procedimento estabelece o controle de tensão na área. E o limite de 260 MW."
    accepted, failures = check_claim(
        claim_with(quote, "O documento estabelece controle de tensão com limite de 260 MW"),
        {"c1": hit(text=prose, locator={"page": 3, "section": "5"})},
    )
    assert accepted is None
    assert any(failure.code == "quote_not_in_chunk" for failure in failures)
