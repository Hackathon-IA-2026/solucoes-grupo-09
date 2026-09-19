"""A quote must carry what it is about: the submarket, the item, the deadline."""

from __future__ import annotations

from wattsteer_rag.chunk import chunk_pages
from wattsteer_rag.evidence import _accepted_citation, _numbers_not_quoted
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
