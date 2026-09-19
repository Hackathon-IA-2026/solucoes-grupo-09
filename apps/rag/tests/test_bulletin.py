"""The daily bulletin's HTML, read one row at a time."""

from __future__ import annotations

BALANCE = """<table><tr><th>Balanço de Energia Acumulado no Mês Até o Dia</th></tr>
<tr><td><table>
<tr><td colspan=4>SISTEMA INTERLIGADO NACIONAL - SIN - MWmed</td></tr>
<tr><td>Solar</td><td><span id=lbl_sin_solar_p>11.576</span></td>
<td><span id=lbl_sin_solar_v>11.802</span></td><td><span id=lbl_sin_solar_perc>16,61%</span></td></tr>
</table></td></tr>
<tr><td><table>
<tr><td>Eólica</td><td><span id=lbl_perEolicaNE>62,28%</span></td>
<td><span id=lbl_GeracaoEolicaNE>13.431</span></td><td><span id=lbl_GeracaoEolicaNE_P>13.678</span></td></tr>
<tr><td>Hidro</td><td><span id=lbl_per_hidr_N>39,95%</span></td>
<td><span id=lbl_geracaoHidrN>2.710</span></td><td><span id=lbl_geracaoHidrNP>2.424</span></td></tr>
</table></td></tr></table>
<table><tr><td>Total</td><td><span id=lbl_tInt_V>42</span></td>
<td><span id=lbl_acaray_P_N>0</span></td></tr></table>"""


def test_the_balance_names_the_subsystem_and_the_column_its_image_draws():
    """Measured on 2026-09-18: the balance was one pipe table, "Eólica | 62,28% |
    13.431 | 13.678" with no subsystem and no column, and nested tables ran its
    blocks together. Asked for LAPA's solar output the model quoted the SIN's
    11,802 from the same chunk. The subsystem and the column exist only in the
    cell ids."""
    from wattsteer_rag.bulletin import bulletin_lines

    lines = bulletin_lines(BALANCE, "BDO 07/09/2026")
    assert (
        "| Solar | SIN programado: 11.576 | SIN verificado: 11.802 | SIN participação: 16,61% |" in lines[0]
    )
    assert "Nordeste verificado: 13.431 | Nordeste programado: 13.678" in lines[1]
    assert "Norte verificado: 2.710 | Norte programado: 2.424" in lines[2]
    assert all(
        line.startswith("| BDO 07/09/2026 - Balanço de Energia Acumulado no Mês") for line in lines[:3]
    )
    # The exchange total is also a "Total", but its ids are not the balance's.
    assert not any("Norte verificado: 0" in line for line in lines)


PLANTS = """<span>Subsistema Sul</span>
<table><tr><th colspan=3>Produção Solar por Usina</th></tr>
<tr><th>Usina</th><th>Programado (MWmed)</th><th>Verificado (MWmed)</th></tr>
<tr><td>--> CONJUNTO FOTOVOLTAICO LAPA --></td><td>11,00</td><td>9,39</td></tr>
<tr><td>CONJUNTO FOTOVOLTAICO ALEX</td><td>74,25</td><td>87,15</td></tr></table>
<table><tr><th>Bacia</th><th>Reservatório</th><th colspan=2>Vazão - m³/s</th></tr>
<tr><th>Afluência</th><th>Defluência</th></tr>
<tr><td>IGUACU</td><td>SEGREDO</td><td>3.334</td><td>3.262</td></tr>
<tr><td>SALTO SANTIAGO</td><td>4.144</td><td>4.187</td></tr></table>
<p>Observações</p><table><tr><td>Não houve integração de novos equipamentos neste dia.</td></tr></table>
<script>gtag('config', 'UA-1');</script>"""


def test_every_bulletin_row_carries_its_own_column_names():
    """A table of 200 plants under one header left a number six rows below the
    name of its column. Each row now stands alone, and a row shortened by a
    rowspan borrows the cells it spans."""
    from wattsteer_rag.bulletin import bulletin_lines

    lines = bulletin_lines(PLANTS)
    lapa = next(line for line in lines if "LAPA" in line)
    assert "Usina: CONJUNTO FOTOVOLTAICO LAPA | Programado (MWmed): 11,00 | Verificado (MWmed): 9,39" in lapa
    assert "-->" not in lapa
    assert "Bacia: IGUACU | Reservatório: SALTO SANTIAGO | Vazão - m³/s Afluência: 4.144" in lines[3]
    assert "Não houve integração de novos equipamentos neste dia." in lines[4]
    assert not any("gtag" in line for line in lines)


def test_each_bulletin_row_is_its_own_chunk(tmp_path):
    """The one-row pipe tables are never absorbed into a neighbour, so a quote
    can only carry the numbers of the row it came from."""
    from wattsteer_rag.chunk import chunk_pages
    from wattsteer_rag.parse import parse_html_tables

    page = tmp_path / "bdo.html"
    page.write_text(PLANTS)
    parsed = parse_html_tables(page, "Boletim Diário da Operação 07/09/2026 - Producao Solar Usina")
    chunks = chunk_pages([{"page_no": 1, "markdown": parsed[0].markdown, "blocks": []}])
    lapa = [chunk for chunk in chunks if "LAPA" in chunk.text]
    assert len(lapa) == 1 and "ALEX" not in lapa[0].text
    assert "07/09/2026" in lapa[0].text


RESERVE = """<table><tr><th>Área de Operação</th><th>Disponibilidade Sincronizada (a)</th>
<th>Geração Verificada (b)</th><th>Reserva Girante (c = a - b)</th><th>Hora</th></tr>
<tr><td>COSR-NE</td><td>28.843</td><td>28.622</td><td>221</td><td rowspan=5>19:14:00</td></tr>
<tr><td>SIN</td><td>101.479</td><td>95.645</td><td>5.834</td></tr>
<tr><td>- Geração Disponível Sincronizada = Potência instalada - Perda de potência.</td></tr></table>"""


def test_a_row_shortened_on_the_right_is_not_shifted_to_the_right():
    """Measured on 2026-09-08: the SIN row of the spinning reserve lacks the
    hour (a rowspan on the right). Borrowing the first cell from the row above
    stored "Disponibilidade Sincronizada (a): SIN | Geração Verificada (b):
    101.479 | Reserva Girante: 95.645", and the answer quoted 95.645 as the
    reserve. The reservoirs, short on the left, still borrow the basin."""
    from wattsteer_rag.bulletin import bulletin_lines

    sin = next(line for line in bulletin_lines(RESERVE) if "SIN" in line)
    assert "Área de Operação: SIN | Disponibilidade Sincronizada (a): 101.479" in sin
    assert "Reserva Girante (c = a - b): 5.834" in sin
    note = bulletin_lines(RESERVE)[-1]
    assert "Área de Operação:" not in note and "Potência instalada" in note


def test_the_month_to_date_balance_does_not_answer_for_a_day():
    """Sixth measured run: asked for the Sul's verified load on 10/09/2026, the
    answer quoted the month-to-date page (14.452) instead of the day's (14.611)."""
    from wattsteer_rag.evidence import Record, _month_to_date_failure
    from wattsteer_rag.retrieve import Hit

    def bdo(text: str) -> Hit:
        return Hit(
            "c1", "d1", text, {"page": 1}, None, "BDO", "BDO", "u", "BDO 2026-09-10 02", None, None, "x", 1.0
        )

    month = bdo("| BDO - Balanço de Energia Acumulado no Mês Até o Dia | Carga(*) | Sul verificado: 14.452 |")
    day = bdo("| BDO - Balanço de Energia Diário | Carga(*) | Sul verificado: 14.611 |")
    asks_day = Record(question="Qual foi a carga verificada do Sul em 10/09/2026?")
    asks_month = Record(question="Qual a carga acumulada no mês do Sul até 10/09/2026?")
    assert _month_to_date_failure(month, asks_day).code == "citation_month_to_date"
    assert _month_to_date_failure(day, asks_day) is None
    assert _month_to_date_failure(month, asks_month) is None
