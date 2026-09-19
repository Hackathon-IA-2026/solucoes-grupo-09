"""Operating instructions: step tables, titles and the page band."""

from __future__ import annotations

STEP_PAGE = (
    "## ## 6.2. PROCEDIMENTOS ESPECIFICOS PARA O CONTROLE DO CARREGAMENTO DE LINHAS DE TRANSMISSÃO\n\n"
    "## ### 6.2.1 CONTROLE DE CARREGAMENTO DA LT 230 KV PAULO AFONSO / TACARATU – C1(F1)\n\n"
    "## 6.2.2 CONTROLE DE CARREGAMENTO DA LT 230 KV MILAGRES / COREMAS – C1(M6) E C2(M5) "
    "PREVENINDO A PERDA DA LT 230 KV MILAGRES / COREMAS – C1(M6)\n\n"
    "| Instruções de Operação | Código | Revisão | Item | Vigência |\n| --- | --- | --- | --- | --- |\n"
    "| Operação Normal da Área 230 kV Norte da Região Nordeste | IO-ON.NE.2NO | 169 | 3.1.1.3. "
    "| 01/09/2026 |\n\n"
    "| Passo | Coordenação | Procedimento |\n| --- | --- | --- |\n"
    "| 1 | COSR-NE | Remanejar a geração, considerando uma redução de 100 MW. |\n"
    "| 1.1 | Agentes | Tacaratu -75 |\n\n"
    "| Passo | Coordenação | Procedimento |\n| --- | --- | --- |\n"
    "| 1 | COSR-NE | Monitorar a seguinte inequação: P(MLG/CMA M6) + P(MLG/CMA M5) ≤ 275 MW |\n"
    "| 2 | COSR-NE | Para controlar a inequação, remanejar a geração. |\n"
    "| 2.1 | Agentes | Coremas -100 |\n\n"
    "S\nE\n\nAlterado pela(s) MOP(s):\nMOP/ONS 136-S/2026:\n"
    "Manual de Procedimentos da Operação - Modulo 5 Submódulo 5.12"
)


def test_step_tables_keep_their_own_title_one_step_per_chunk():
    """Measured on IO-ON.NE.2NO page 9 (2026-09-18): the vision model returns
    both titles before both tables, so the 275 MW limit of 6.2.2 was filed under
    6.2.3; 6.2.2's title, 125 characters, was not read as a title at all; and
    each table was one chunk holding every step."""
    from wattsteer_rag.chunk import chunk_pages

    chunks = chunk_pages([{"page_no": 9, "markdown": STEP_PAGE, "blocks": []}])
    tacaratu = next(chunk for chunk in chunks if "Tacaratu -75" in chunk.text)
    assert tacaratu.section_path.startswith("6.2.1 ")  # not the parent, 6.2
    limit = next(chunk for chunk in chunks if "≤ 275 MW" in chunk.text)
    assert limit.section_path.startswith("6.2.2 ") and limit.text.startswith("6.2.2 CONTROLE")
    step_two = next(chunk for chunk in chunks if "Coremas -100" in chunk.text)
    assert "275 MW" not in step_two.text and "| Passo |" in step_two.text
    assert step_two.section_path.startswith("6.2.2 ")


def test_the_running_header_and_footer_are_not_evidence():
    """A case quoted "Alterado pela(s) MOP(s): ... Submódulo 5.12" as evidence.
    The band goes; a limit alone on its line, and a sentence that happens to
    start with the operator's name, stay."""
    from wattsteer_rag.chunk import chunk_pages, strip_furniture

    text = " ".join(
        chunk.text for chunk in chunk_pages([{"page_no": 9, "markdown": STEP_PAGE, "blocks": []}])
    )
    assert "Alterado pela" not in text and "Instruções de Operação | Código" not in text
    assert "\nS\n" not in text and "Submódulo 5.12" not in text

    kept = strip_furniture(
        "Usinas derivadas das SEs\n57 MW\n- 25\n"
        "Operador Nacional do Sistema Elétrico – ONS, bem como as diretrizes operativas\n5/23"
    )
    assert "57 MW" in kept and "- 25" in kept and "bem como as diretrizes" in kept
    assert "5/23" not in kept


def test_a_number_in_another_column_is_not_a_new_step():
    """Review of #21: the first non-empty cell was read as the step, so a
    continuation row with a value in a later column split the step."""
    from wattsteer_rag.chunk import split_steps

    table = (
        "|  | Passo | Procedimento | MW |\n| --- | --- | --- | --- |\n"
        "|  | 1 | Remanejar a geração, considerando uma redução de 100 MW. |  |\n"
        "|  |  |  | 75 |\n"
        "|  | 2 | Monitorar a inequação. |  |"
    )
    pieces = split_steps(table)
    assert len(pieces) == 2
    assert "75" in pieces[0] and "Monitorar" in pieces[1]
