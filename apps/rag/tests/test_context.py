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


IPDO_HIGHLIGHTS_P3 = (
    "4 - Destaques da Operação\n\n"
    "   * CARGA E PRODUÇÃO DE ENERGIA POR SUBMERCADO\n\n"
    "   Submercado Sul:\n\n"
    "     A geração hidráulica foi inferior ao programado devido à carga inferior.\n\n"
    "   Submercado Norte:\n\n"
    "     A geração hidráulica foi superior ao programado para atendimento à ponta.\n\n"
    "   * RESTRIÇÃO DE GERAÇÃO RENOVÁVEL\n\n"
    "   Submercado Sul:\n\n"
    "       Valor máximo: 24 MW.\n"
    "       Período: Das 06h56 às 13h56.\n"
    "       Motivos: Controle de frequência.\n"
)
IPDO_HIGHLIGHTS_P4 = (
    "   Submercado Nordeste:\n\n"
    "     Valor máximo: 13.671 MW.\n"
    "     Período: Da 00h00 às 23h59.\n\n"
    "   * INTERCÂMBIO INTERNACIONAL\n\n"
    "       Nada a relatar.\n"
)


def test_an_ipdo_submarket_knows_which_highlight_it_is_under():
    """Measured on 20/09/2026: asked for the IPDO's main occurrence, the answer
    quoted the right document and the wrong section. The highlights repeat
    "Submercado Sul:" under each starred heading, and the heading itself was
    read as prose, so it was glued to the end of the previous submarket: the
    Norte production paragraph carried the words "RESTRIÇÃO DE GERAÇÃO
    RENOVÁVEL" and the chunk that holds the 24 MW did not, and both Sul chunks
    had the same section. The heading belongs to every submarket under it,
    including the one continued on the next page, and to none above it."""
    chunks = chunk_pages(
        [
            {"page_no": 3, "markdown": IPDO_HIGHLIGHTS_P3, "blocks": []},
            {"page_no": 4, "markdown": IPDO_HIGHLIGHTS_P4, "blocks": []},
        ]
    )
    production = next(chunk for chunk in chunks if "ponta" in chunk.text)
    assert production.section_path == "CARGA E PRODUÇÃO DE ENERGIA POR SUBMERCADO > Submercado Norte"
    assert "RESTRIÇÃO" not in production.text
    sul = next(chunk for chunk in chunks if "24 MW" in chunk.text)
    assert sul.section_path == "RESTRIÇÃO DE GERAÇÃO RENOVÁVEL > Submercado Sul"
    assert sul.text.startswith("* RESTRIÇÃO DE GERAÇÃO RENOVÁVEL")
    nordeste = next(chunk for chunk in chunks if "13.671" in chunk.text)
    assert nordeste.section_path == "RESTRIÇÃO DE GERAÇÃO RENOVÁVEL > Submercado Nordeste"
    assert nordeste.page_start == 4 and "RESTRIÇÃO DE GERAÇÃO RENOVÁVEL" in nordeste.text
    exchange = next(chunk for chunk in chunks if "Nada a relatar" in chunk.text)
    assert exchange.section_path == "INTERCÂMBIO INTERNACIONAL"


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


def _ipdo(text: str, section: str | None) -> Hit:
    return Hit(
        "c1",
        "d1",
        text,
        {"page": 3, "section": section},
        section,
        "IPDO",
        "IPDO",
        "u",
        "IPDO 2026-09-14",
        None,
        None,
        "x",
        1.0,
    )


def test_an_ipdo_answer_comes_from_the_highlight_and_submarket_asked():
    """Reported by the domain specialist on 20/09/2026: asked for the main
    occurrence in the IPDO of 14/09, the answer quoted the stored-energy section
    of the same document. The document was right and the section was wrong, and
    nothing refused it because every quote was literal. The report is one
    template, so a question that names one of its highlights, or one submarket,
    names the only part of it that can answer."""
    from wattsteer_rag.gate import Record, _section_failure, check_claim

    occurrence = Record(question="No IPDO de 14/09/2026, qual foi a principal ocorrência registrada no SIN?")
    stored = _ipdo(
        "3 - Variação de Energia Armazenada | Sudeste | -0,4 |", "3 - Variação de Energia Armazenada"
    )
    assert _section_failure(stored, occurrence).code == "citation_other_section"
    assert _section_failure(_ipdo("* OCORRÊNCIAS\n\nNada a relatar.", "OCORRÊNCIAS"), occurrence) is None
    wrong = {
        "claim": "A energia armazenada variou -0,4.",
        "citations": [{"chunk_id": "c1", "quote": stored.text}],
    }
    claim, failures = check_claim(wrong, {"c1": stored}, occurrence)
    assert claim is None and failures[-1].code == "citation_other_section"

    south = Record(
        question=(
            "No IPDO de 21/09/2026, qual foi o valor máximo da restrição de geração renovável "
            "no submercado Sul?"
        )
    )
    production = _ipdo(
        "Submercado Sul:\n\nA geração hidráulica foi inferior ao programado.",
        "CARGA E PRODUÇÃO DE ENERGIA POR SUBMERCADO > Submercado Sul",
    )
    north = _ipdo(
        "Submercado Norte:\n\nValor máximo: 303 MW.", "RESTRIÇÃO DE GERAÇÃO RENOVÁVEL > Submercado Norte"
    )
    right = _ipdo(
        "Submercado Sul:\n\nValor máximo: 24 MW.", "RESTRIÇÃO DE GERAÇÃO RENOVÁVEL > Submercado Sul"
    )
    assert _section_failure(production, south).code == "citation_other_section"
    assert _section_failure(north, south).code == "citation_other_section"
    assert _section_failure(right, south) is None


def test_the_section_lock_stays_out_of_what_it_cannot_read():
    """It only knows the IPDO's highlights. A question that names neither a
    highlight nor a submarket, and any other document, are left to the other
    gates, or it would refuse the tables that answer load and generation."""
    from wattsteer_rag.gate import Record, _section_failure

    table = _ipdo("| Carga | Sul | 14.611 |", "1 - Balanço de Energia")
    assert (
        _section_failure(table, Record(question="Qual foi a carga verificada no IPDO de 14/09/2026?")) is None
    )
    southeast = Record(
        question="Qual foi a restrição de geração renovável no submercado Sudeste/Centro-Oeste em 21/09/2026?"
    )
    sul = _ipdo("Valor máximo: 24 MW.", "RESTRIÇÃO DE GERAÇÃO RENOVÁVEL > Submercado Sul")
    assert _section_failure(sul, southeast).code == "citation_other_section"
    bdo = Hit(
        "c1",
        "d1",
        "| Sul | 14.611 |",
        {"page": 1},
        None,
        "BDO",
        "BDO",
        "u",
        "BDO 2026-09-14 02",
        None,
        None,
        "x",
        1.0,
    )
    assert _section_failure(bdo, southeast) is None


def test_the_section_lock_reads_names_and_editions_as_they_are():
    """Review of this change, each case run against the first version, which
    refused all four: a state named after a region is not a submarket, "ocorreu"
    is not an occurrence, the 2025 editions split OCORRÊNCIAS in two, and a
    highlight that only restates a table does not lock the table out."""
    from wattsteer_rag.gate import Record, _section_failure

    nordeste = _ipdo("Valor máximo: 13.671 MW.", "RESTRIÇÃO DE GERAÇÃO RENOVÁVEL > Submercado Nordeste")
    in_a_state = Record(question="Houve restrição de geração renovável no Rio Grande do Norte em 21/09/2026?")
    assert _section_failure(nordeste, in_a_state) is None

    balance = _ipdo("| Carga | Sul | 14.611 |", "1 - Balanço de Energia")
    assert _section_failure(balance, Record(question="O que ocorreu com a carga no IPDO de 14/09?")) is None
    production = Record(question="Qual a carga e produção de energia por submercado no IPDO de 14/09?")
    assert _section_failure(balance, production) is None

    network = _ipdo("Desligamento da LT 500 kV.", "OCORRÊNCIAS NA REDE DE OPERAÇÃO")
    occurrence = Record(question="Qual foi a principal ocorrência no IPDO de 27/10/2025?")
    assert _section_failure(network, occurrence) is None


def test_a_claim_may_not_conclude_what_its_quote_does_not_say():
    """Measured on 22/09/2026, three times in a row: asked whether a restriction
    for surplus was registered in the Nordeste's balance of 14/09, the answer
    quoted the BDO's balance row and added "indicando excedente de energia".
    Every number was in the quote, and the second reader agreed three times out
    of three, with the same reasoning: verified above scheduled means surplus.
    The balance has no restriction line. Told in its prompt that deriving a
    thing from two figures is not reading it, it agreed three more times, so
    the conclusion is refused where it is written, like causal wording."""
    from wattsteer_rag.gate import check_claim

    row = "| Balanço de Energia Diário | Total | Nordeste verificado: 25.291 | Nordeste programado: 24.399 |"
    by_chunk = {"c1": _hit(row)}
    concluded = {
        "claim": (
            "O balanço registrou verificado de 25.291 e programado de 24.399, indicando excedente de energia."
        ),
        "citations": [{"chunk_id": "c1", "quote": row}],
    }
    claim, failures = check_claim(concluded, by_chunk)
    assert claim is None and failures[-1].code == "claim_draws_conclusion"

    stated = {
        "claim": "O balanço registrou verificado de 25.291 e programado de 24.399 no Nordeste.",
        "citations": [{"chunk_id": "c1", "quote": row}],
    }
    assert check_claim(stated, by_chunk)[0] is not None


def test_a_document_that_states_something_is_not_a_conclusion():
    """ "A IO indica que..." reports what the document says; only the
    connective that attaches a reading to figures is refused."""
    from wattsteer_rag.gate import conclusion_hits

    assert conclusion_hits("A IO-ON.NE.2NO indica que a inequação deve ser monitorada.") == []
    assert conclusion_hits("A IO define o fluxo na LT C1(V7), indicando o sentido positivo.") == []
    assert conclusion_hits("defeito reincidente num período de 12 meses, caracterizando a urgência") == []
    assert conclusion_hits("O verificado ficou em 25.291 MW, o que mostra um excedente.") == ["o que mostra"]


def test_a_claim_about_an_agent_answers_a_question_about_that_agent():
    """Measured on 22/09/2026: asked when the ONS authorised the total
    restoration (14h49), the answer gave when LIGHT, CEMIG D or CPFL finished
    theirs. The report holds a restoration time per agent, each a literal quote,
    and the second reader accepted them. Of 274 stored question and claim pairs,
    the 11 that named an agent the question did not were these, plus four for a
    question about the agents in general, which is allowed to name one."""
    from wattsteer_rag.gate import Record, check_claim

    action = (
        "9.82.1 O agente LIGHT deverá informar ao ONS o motivo de ter concluído o restabelecimento às 09h44."
    )
    by_chunk = {"c1": _hit(action)}
    item = {
        "claim": "O agente LIGHT concluiu o restabelecimento total das cargas às 09h44.",
        "citations": [{"chunk_id": "c1", "quote": action}],
    }
    asks_ons = Record(question="A que horas o ONS autorizou o restabelecimento total das cargas?")
    claim, failures = check_claim(item, by_chunk, asks_ons)
    assert claim is None and failures[-1].code == "claim_about_another_agent"

    for question in (
        "Quando o agente LIGHT concluiu o restabelecimento das cargas?",
        "Qual o prazo para os agentes implementarem as providências do RAP de 15/08/2023?",
    ):
        assert check_claim(item, by_chunk, Record(question=question))[0] is not None, question
