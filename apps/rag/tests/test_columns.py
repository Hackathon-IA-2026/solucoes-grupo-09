"""A small text-layer table, given back its column names."""

from __future__ import annotations

from wattsteer_rag.columns import label_columns

HEADER = "                   Energia Armazenada                 SIN      Sul      SE/CO     Norte     NE\n\n"


def test_each_number_gets_its_column_even_when_the_layout_moves_it():
    """Measured on the stored IPDOs (19/09/2026): the storage table's numbers
    sit on the label's line (2018), on the line below it (2023) or on the line
    above it (2025), with blank lines between rows. Asked for the Northeast's
    storage, the answer could not tell which of five numbers was the NE's."""
    below = HEADER + (
        "    Armazenamento ao final do dia (MWmês)\n\n"
        "                                    225.075   18.903   157.616   12.104   36.453\n\n"
        "    Armazenamento ao final do dia (%)        77,1%    92,4%     77,0%    79,1%    70,5%\n"
    )
    text = label_columns(below)
    assert "Armazenamento ao final do dia (MWmês) | SIN: 225.075 | Sul: 18.903" in text
    assert "NE: 36.453" in text and "NE: 70,5%" in text

    above = HEADER + (
        "    Capacidade Máxima (MWmês)        292.068   20.459   204.615   15.302   51.691\n\n"
        "                                     153.799   18.592    96.283   12.137   26.787\n\n"
        "    Armazenamento ao final do dia (MWmês)\n\n"
        "    Armazenamento ao final do dia (%)  52,7%    90,9%     47,1%    79,3%    51,8%\n"
    )
    text = label_columns(above)
    assert "Armazenamento ao final do dia (MWmês) | SIN: 153.799" in text
    assert "Capacidade Máxima (MWmês) | SIN: 292.068" in text


def test_a_bare_line_two_labels_could_claim_is_left_alone():
    """Between two labels with no numbers, bare numbers could belong to either;
    a guess would put a value under the wrong row, so nothing is paired."""
    ambiguous = HEADER + (
        "    Armazenamento ao final do dia (MWmês)\n\n"
        "                                    225.075   18.903   157.616   12.104   36.453\n\n"
        "    Variação acumulada mensal (%)\n"
    )
    assert "|" not in label_columns(ambiguous)
    assert label_columns("Passo   Coordenação   Procedimento\n1   COSR-NE   Monitorar") == (
        "Passo   Coordenação   Procedimento\n1   COSR-NE   Monitorar"
    )


def test_rechunk_labels_the_stored_text_layer_pages():
    """Review of #25: rechunk reused a text-layer page's stored markdown, so
    the corpus already indexed kept its unlabelled tables until each PDF was
    read again. The stored text is the text layer, so the rule applies to it."""
    from wattsteer_rag.ingest import _rebuilt_markdown

    stored = HEADER + "    Armazenamento ao final do dia (%)   52,7%   90,9%   47,1%   79,3%   51,8%\n"
    markdown, _ = _rebuilt_markdown({"blocks": [], "parser": "local:pdftotext", "markdown": stored})
    assert "NE: 51,8%" in markdown
    vision, _ = _rebuilt_markdown({"blocks": [], "parser": "nvidia:nemotron-parse", "markdown": stored})
    assert vision == stored
