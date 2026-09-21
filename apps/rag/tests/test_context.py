"""A quote must carry what it is about: the submarket, the item, the deadline."""

from __future__ import annotations

from wattsteer_rag.chunk import chunk_pages
from wattsteer_rag.gate import _accepted_citation, _numbers_not_quoted
from wattsteer_rag.retrieve import Hit

IPDO_P3 = (
    "4 - Destaques da Operação\n"
    "   Submercado Sul:\n"
    "     A geração hidráulica foi inferior ao valor programado.\n"
    "     Das 09h32 às 14h25 houve restrição de geração eólica para controle\n"
    "   da frequência do SIN. A máxima redução foi de 49 MW.\n"
    "   Submercado Norte:\n"
    "     A geração térmica não apresentou desvio significativo.\n"
)
IPDO_P4 = "     Das 09h37 às 14h07 houve restrição de geração eólica. A máxima redução foi de 128 MW.\n"


def test_each_ipdo_paragraph_knows_its_submarket_even_on_the_next_page():
    """Measured on 18/09/2026: the IPDO writes "Submercado Sul:" on its own line
    and then the paragraphs, and the submarket was lost to them. A reduction
    quoted from the paragraph was refused, rightly, as not naming the submarket,
    and one continued on the next page lost it entirely."""
    chunks = chunk_pages(
        [
            {"page_no": 3, "markdown": IPDO_P3, "blocks": []},
            {"page_no": 4, "markdown": IPDO_P4, "blocks": []},
        ]
    )
    sul = next(chunk for chunk in chunks if "49 MW" in chunk.text)
    assert sul.section_path == "Submercado Sul" and "128 MW" not in sul.text
    norte = next(chunk for chunk in chunks if "128 MW" in chunk.text)
    assert norte.section_path == "Submercado Norte" and norte.page_start == 4


def _hit(text: str, section: str | None = None) -> Hit:
    return Hit(
        chunk_id="c1",
        document_id="d1",
        text=text,
        locator={"page": 397, "section": section},
        section_path=section,
        source="RAP",
        title="RAP",
        url="https://example",
        external_id="RAP 2023-08-15",
        revision=None,
        published_at=None,
        sha256="x",
        score=1.0,
    )


def test_a_long_quote_keeps_its_deadline():
    """The accepted quote was cut at 300 characters before the number gate read
    it, so "Prazo: 31/12/2023", which closes an action of the RAP after a long
    run of layout spaces, was never seen and the claim was refused."""
    action = (
        "9.1.8      Reavaliar os procedimentos para o fechamento do anel entre as Áreas do Nordeste, na\n"
        "           SE Sobral III, por meio da LT 500kV Sobral III - Tianguá II, considerando os insucessos\n"
        "           durante as tentativas de religamento da linha, em razão das atuações de proteção de\n"
        "           sobretensão ocorridas durante a energização.\n"
        "            Prazo: 31/12/2023                                     Gestor: EGE"
    )
    citation = _accepted_citation(_hit(action), "c1", action, False, {"page": 397})
    assert "31/12/2023" in citation["quote"]
    assert _numbers_not_quoted("O prazo é 31/12/2023.", [citation]) == []


def test_naming_the_cited_item_invents_no_number():
    """A claim that says "item 6.2.1" repeats what the citation prints next to
    its quote; the number gate refused it as a number not in the quote."""
    citation = {
        "quote": "P(CMQM1/CTU) + 0,70*P(CMQM2/CTU) < 301 MW",
        "locator": {"section": "6.2.1 CONTROLE"},
    }
    assert _numbers_not_quoted("O item 6.2.1 fixa 0,70 e 301 MW.", [citation]) == []
    assert _numbers_not_quoted("O item 6.2.1 fixa 302 MW.", [citation])


def test_a_quote_that_points_to_the_table_needs_the_row_it_points_to():
    """Measured on 19/09/2026: asked how much the plants of SE Mauriti II must
    vary, the answer quoted only the preamble and gave the step's 100 MW total;
    the row ("Mauriti II | - 75") was in the same chunk."""
    from wattsteer_rag.gate import check_claim

    step = (
        "| Passo | Procedimento |\n| --- | --- |\n"
        "| 1 | Para controlar o carregamento da LT 230 KV Mauriti II / Milagres – C1(L3), "
        "remanejar a geração nas usinas definidas na tabela abaixo, considerando uma redução de 100 MW. |\n"
        "| 1.1 | Usinas derivadas das SEs | MW |\n|  | Mauriti II | - 75 |"
    )
    preamble = (
        "Para controlar o carregamento da LT 230 KV Mauriti II / Milagres – C1(L3), remanejar a geração "
        "nas usinas definidas na tabela abaixo, considerando uma redução de 100 MW."
    )
    by_chunk = {"c1": _hit(step, "6.2.3 CONTROLE")}
    only = {"claim": "Reduzir 100 MW.", "citations": [{"chunk_id": "c1", "quote": preamble}]}
    claim, failures = check_claim(only, by_chunk)
    assert claim is None and failures[-1].code == "quote_points_to_table"

    with_row = {
        "claim": "As usinas da SE Mauriti II variam - 75 MW numa redução de 100 MW.",
        "citations": [
            {"chunk_id": "c1", "quote": preamble},
            {"chunk_id": "c1", "quote": "| Mauriti II | - 75 |"},
        ],
    }
    claim, _ = check_claim(with_row, by_chunk)
    assert claim is not None


def test_the_pointer_rule_reads_values_not_pipes():
    """Review of #22: pipes do not prove a row is there. The preamble quoted as
    a Markdown row is still only a pointer; a row assembled without pipes
    still carries the value."""
    from wattsteer_rag.gate import _points_to_table

    preamble = (
        "remanejar a geração nas usinas definidas na tabela abaixo, considerando uma redução de 100 MW."
    )
    assert _points_to_table(f"| 1 | Para controlar o carregamento, {preamble} |")
    assert not _points_to_table(f"Para controlar o carregamento, {preamble} Mauriti II - 75")
    assert not _points_to_table(f"| 1 | {preamble} |\n| 1.1 | Mauriti II | - 75 |")


def test_a_long_section_is_bounded_and_its_number_reaches_the_whitelist():
    """Review of #22: a 125-character IO title overran the contract's 120 for
    locator.section, and the cited item's number was allowed by the gate but
    missing from the narration's whitelist."""
    from wattsteer_rag.evidence import _settle
    from wattsteer_rag.gate import _accepted_citation

    title = (
        "6.2.2 CONTROLE DE CARREGAMENTO DA LT 230 KV MILAGRES / COREMAS – C1(M6) E C2(M5) "
        "PREVENINDO A PERDA DA LT"
    )
    citation = _accepted_citation(
        _hit("P(MLG/CMA M6) + P(MLG/CMA M5) ≤ 275 MW", title * 2), "c1", "≤ 275 MW", False, {}
    )
    assert len(citation["locator"]["section"]) <= 120
    document = {}
    _settle(document, [{"supports": "CNF", "evidence_weight": 1.0, "citations": [citation], "claim": "x"}])
    assert "6.2.2" in document["numbers_whitelist"] and "275" in document["numbers_whitelist"]


def test_the_pointer_knows_the_spellings_the_instructions_use():
    """Review of the 19/09 run: the rule knew `tabela abaixo` and `tabela a
    seguir` and nothing else, so the same preamble was refused in one operating
    instruction and accepted in the next. `quadro`, a numbered table and
    `seguinte` are the same sentence doing the same thing."""
    from wattsteer_rag.gate import _points_to_table

    for pointer in (
        "remanejar a geração nas usinas definidas na tabela abaixo, considerando 100 MW.",
        "remanejar a geração nas usinas definidas na tabela a seguir, considerando 100 MW.",
        "remanejar a geração nas usinas definidas na tabela seguinte, considerando 100 MW.",
        "remanejar a geração nas usinas definidas na tabela 1, considerando 100 MW.",
        "remanejar a geração nas usinas definidas no quadro abaixo, considerando 100 MW.",
        "remanejar a geração conforme o quadro 6.2, considerando 100 MW.",
    ):
        assert _points_to_table(pointer), pointer


def test_a_bare_table_word_is_not_a_pointer():
    """The word appears in rows and in titles. Refusing on it would refuse the
    row the pointer rule exists to ask for."""
    from wattsteer_rag.gate import _points_to_table

    assert not _points_to_table("| Tabela de usinas | Mauriti II | - 75 |")
    assert not _points_to_table("A tabela apresenta as usinas derivadas, com 302 MW no total.")


def test_a_widened_pointer_still_accepts_the_quote_that_brings_the_row():
    """The half that must not be lost: widening what counts as a pointer may not
    refuse a citation that actually carries the value."""
    from wattsteer_rag.gate import _points_to_table

    preamble = (
        "remanejar a geração nas usinas definidas no quadro abaixo, considerando uma redução de 100 MW."
    )
    assert not _points_to_table(f"| 1 | {preamble} |\n| 1.1 | Mauriti II | - 75 |")
    assert not _points_to_table(f"Para controlar o carregamento, {preamble} Mauriti II - 75")
