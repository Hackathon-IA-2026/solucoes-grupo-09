"""The gates are the product. If they can be talked past, nothing else matters."""

from __future__ import annotations

from datetime import UTC, datetime

from wattsteer_rag.evidence import question_for
from wattsteer_rag.gate import (
    causal_hits,
    check_claim,
    flatten_for_match,
    has_substance,
    numbers_in,
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
    "| 1 | COSR-NE | Controlar a tensão de 230 kV da SE Senhor do Bonfim II, "
    "de acordo com os limites abaixo: "
    "| - Evitar colapso de tensão |\n| | | PSNB | Tensão | QSNB |\n| | | PSNB ≤ 260 MW | VSNB ≥ 230 kV | - |"
)


def test_a_table_citation_may_skip_cells_but_not_reorder_them():
    """The row that names the control and the row that carries the limit are the
    citation a person would point at, and they are never adjacent in a table."""
    quote = (
        "Controlar a tensão de 230 kV da SE Senhor do Bonfim II, de acordo com os limites abaixo:"
        " | PSNB ≤ 260 MW | VSNB ≥ 230 kV"
    )
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
    prose = (
        "O procedimento estabelece o controle de tensão na área."
        " Outra frase qualquer no meio. E o limite de 260 MW."
    )
    quote = "O procedimento estabelece o controle de tensão na área. E o limite de 260 MW."
    accepted, failures = check_claim(
        claim_with(quote, "O documento estabelece controle de tensão com limite de 260 MW"),
        {"c1": hit(text=prose, locator={"page": 3, "section": "5"})},
    )
    assert accepted is None
    assert any(failure.code == "quote_not_in_chunk" for failure in failures)


def test_a_stack_of_section_titles_is_not_a_statement():
    """Two headings quoted together read like an answer and state nothing. A
    numbered clause starts the same way and is evidence, so the gate has to tell
    them apart."""
    from wattsteer_rag.gate import has_substance

    assert not has_substance(
        "5. LIMITACOES DA TRANSMISSAO E/OU DA GERACAO E PROCEDIMENTOS ASSOCIADOS\n"
        "## 5.1. LIMITACAO DA TRANSMISSAO NAS LTS 500 KV ACU III / QUIXADA - C1(V2)"
    )
    assert has_substance(
        "1.1. Os centros de operacao do ONS, em atendimento ao Programa Diario da"
        " Operacao, controlam a geracao do SIN em tempo real."
    )


def test_the_citation_has_to_be_about_the_record():
    """A quote can be literal, located and still be about somewhere else."""
    from datetime import UTC, datetime

    from wattsteer_rag.gate import Record, _relevance_failure
    from wattsteer_rag.retrieve import Hit

    def hit(source, external_id, published):
        return Hit(
            chunk_id="c",
            document_id="d",
            text="",
            locator={},
            section_path=None,
            source=source,
            title="",
            url="",
            external_id=external_id,
            revision=None,
            published_at=published,
            sha256="",
            score=0.0,
        )

    record = Record.of("pergunta", "Controle de inequação: ... - IO-ON.NE.5NE", "2026-08-25")
    assert record.named_documents == ("IO-ON.NE.5NE",)
    assert _relevance_failure(hit("INSTRUCAO_OPERACAO", "IO-ON.NE.2LE", None), record)
    assert _relevance_failure(hit("INSTRUCAO_OPERACAO", "IO-ON.NE.5NE", None), record) is None
    assert _relevance_failure(hit("PROCEDIMENTOS_REDE", "Submódulo 5.3", None), record) is None

    old_event = datetime(2023, 8, 15, tzinfo=UTC)
    flow = Record.of("pergunta", "Controle do fluxo: FNESE - Conforme SGI 46.480-26", "2026-08-10")
    assert flow.named_documents == ()
    assert _relevance_failure(hit("RAP", "RAP 2023-08-15", old_event), flow)


def test_the_daily_bulletin_html_is_read_as_the_utf8_it_declares(tmp_path):
    """ONS serves the BDO tables as UTF-8 with a BOM and charset=utf-8. Read as
    latin-1 they were indexed as "ProduÃ§Ã£o", which no Portuguese question
    matches (measured on 2026-09-18 over the stored bulletins)."""
    from wattsteer_rag.parse import parse_html_tables

    page = "<table><tr><td>Produção</td><td>Intercâmbio</td></tr><tr><td>1</td><td>2</td></tr></table>"
    utf8 = tmp_path / "bdo.html"
    utf8.write_bytes(b"\xef\xbb\xbf" + page.encode("utf-8"))
    text = parse_html_tables(utf8)[0].markdown
    assert "Produção" in text and "Intercâmbio" in text
    assert "Ã" not in text

    # A file that is not valid UTF-8 still reads, as latin-1.
    legacy = tmp_path / "old.html"
    legacy.write_bytes(page.encode("latin-1"))
    assert "Produção" in parse_html_tables(legacy)[0].markdown


def test_a_bdo_speaks_for_its_day_and_an_ipdo_also_for_the_day_before():
    """Measured on 2026-09-18: a record of 13/12/2025 naming IO-ON.NE.2SO, whose
    revision in force then is not in the corpus, came back `found` citing the
    IPDO of 07/09/2025 about another transformer. The bulletin was literal and
    located, and three months away from the record."""
    from datetime import UTC, datetime

    from wattsteer_rag.gate import Record, _relevance_failure
    from wattsteer_rag.retrieve import Hit

    def bulletin(source, day):
        return Hit(
            chunk_id="c",
            document_id="d",
            text="",
            locator={},
            section_path=None,
            source=source,
            title="",
            url="",
            external_id=f"{source} {day}",
            revision=None,
            published_at=datetime.fromisoformat(day).replace(tzinfo=UTC),
            sha256="",
            score=0.0,
        )

    record = Record.of("pergunta", "Controle de inequação: ... - IO-ON.NE.2SO", "2025-12-13")
    failure = _relevance_failure(bulletin("IPDO", "2025-09-07"), record)
    assert failure is not None and failure.code == "citation_from_another_day"
    assert _relevance_failure(bulletin("BDO", "2025-12-12"), record)
    # A BDO counts only on its own day; the next day's is about another day.
    assert _relevance_failure(bulletin("BDO", "2025-12-13"), record) is None
    assert _relevance_failure(bulletin("BDO", "2025-12-14"), record)
    # The preliminary IPDO is published the next morning, so that one counts too.
    assert _relevance_failure(bulletin("IPDO", "2025-12-13"), record) is None
    assert _relevance_failure(bulletin("IPDO", "2025-12-14"), record) is None


def test_retrieval_leaves_out_the_daily_bulletins_the_gate_would_refuse():
    """Measured on 18/09/2026: with the BDO indexed one row per chunk, a question
    about the IPDO of 01/09/2025 filled its eight passages with BDO rows of
    September 2026 and never saw the IPDO; every draft was then refused as
    citation_from_another_day. The search must apply the gate's day window,
    and the builder must hand it the record's date. There is no database in
    this suite, so the property is held at the source (see testing.md)."""
    import inspect

    from wattsteer_rag import evidence, gate, retrieve

    source = inspect.getsource(retrieve.search)
    assert "target_date" in inspect.signature(retrieve.search).parameters
    assert "'RAP'" in source  # the gate's citation_from_another_event
    for bulletin, days in gate.DAILY_REPORTS.items():
        assert f"'{bulletin}'" in source
        assert f"WHEN 'IPDO' THEN {max(gate.DAILY_REPORTS['IPDO'])}" in source
        assert max(days) in (0, 1)
    assert "target_date=target_date" in inspect.getsource(evidence.build_evidence)
