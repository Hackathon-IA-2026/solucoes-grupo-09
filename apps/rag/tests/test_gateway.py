"""The gateway's promise: one key is enough, five keys are five quotas, and a
provider that runs out is a delay, not an error.
"""

from __future__ import annotations

import time

import pytest

from wattsteer_rag.chunk import chunk_pages, is_table_of_contents
from wattsteer_rag.gateway.limits import Ledger, load_keys
from wattsteer_rag.gateway.router import Gateway, QuotaExhausted
from wattsteer_rag.parse import latex_table_to_markdown

CONFIG = """
version: 1
providers:
  alpha:
    kind: openai_compatible
    base_url: https://alpha.invalid/v1
    api_keys_env: TEST_ALPHA_KEYS
    limits: { rpm: 2 }
  beta:
    kind: openai_compatible
    base_url: https://beta.invalid/v1
    api_key_env: TEST_BETA_KEY
    limits: { rpm: 5 }
  gamma:
    kind: openai_compatible
    base_url: https://gamma.invalid/v1
    api_keys_env: TEST_GAMMA_KEYS
tasks:
  generate_strong:
    chain:
      - { provider: alpha, model: m-big }
      - { provider: beta, model: m-small }
      - { provider: gamma, model: m-none }
  generate_small:
    chain: [{ provider: beta, model: m-small }]
  embed:
    model: e-1
    dimensions: 1024
    chain:
      - { provider: alpha, model: e-1 }
      - { provider: beta, model: e-1 }
  rerank:
    chain: [{ provider: beta, model: r-1 }]
"""


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_ALPHA_KEYS", "key-a1, key-a2 ,, key-a1")
    monkeypatch.setenv("TEST_BETA_KEY", "key-b1")
    monkeypatch.delenv("TEST_GAMMA_KEYS", raising=False)
    path = tmp_path / "gateway.yaml"
    path.write_text(CONFIG)
    return path


def test_a_pool_deduplicates_and_ignores_blanks(config):
    keys = load_keys("alpha", "TEST_ALPHA_KEYS", None)
    assert [key.secret for key in keys] == ["key-a1", "key-a2"]
    assert len({key.id for key in keys}) == 2


def test_one_key_behaves_like_a_pool_of_one(monkeypatch):
    monkeypatch.setenv("ONE", "solo")
    assert [key.secret for key in load_keys("p", "ONE", None)] == ["solo"]
    monkeypatch.setenv("SINGULAR", "solo")
    assert [key.secret for key in load_keys("p", None, "SINGULAR")] == ["solo"]


def test_a_provider_without_keys_is_skipped_not_fatal(config):
    gateway = Gateway(config)
    assert gateway.providers["gamma"].enabled is False
    usable = [provider.name for _, provider in gateway.usable_links("generate_strong")]
    assert usable == ["alpha", "beta"]


def test_the_router_moves_to_the_next_key_then_the_next_provider(config):
    """Every call fails because the hosts do not exist. What matters is the walk."""
    gateway = Gateway(config)
    import asyncio

    with pytest.raises(QuotaExhausted):
        asyncio.run(gateway.run("generate_strong", tokens=10, messages=[{"role": "user", "content": "x"}]))
    tried = [(call["provider"], call["key_id"]) for call in gateway.calls]
    assert len({key for _, key in tried if key}) == 3  # two alpha keys, one beta
    assert [provider for provider, _ in tried][:2] == ["alpha", "alpha"]
    assert tried[-1][0] == "beta"
    asyncio.run(gateway.aclose())


def test_an_embed_chain_may_not_mix_models(tmp_path, monkeypatch):
    monkeypatch.setenv("K", "k")
    path = tmp_path / "bad.yaml"
    path.write_text(
        CONFIG.replace("      - { provider: beta, model: e-1 }", "      - { provider: beta, model: e-2 }")
    )
    with pytest.raises(ValueError, match="vector spaces"):
        Gateway(path)


def test_quota_snapshot_never_carries_a_secret(config):
    gateway = Gateway(config)
    ledger = Ledger()
    ledger.configure("alpha", {"rpm": 2}, None)
    slot = ledger.slot("alpha", "abcd1234", "m-big")
    slot.record(10, time.time())
    snapshot = ledger.snapshot()
    assert snapshot[0]["key_id"] == "abcd1234"
    assert "key-a1" not in str(gateway.quota())


def test_daily_windows_exist_when_declared():
    ledger = Ledger()
    ledger.configure("p", {"rpd": 2}, None)
    slot = ledger.slot("p", "k", "m")
    now = time.time()
    assert slot.room(1, now)
    slot.record(1, now)
    slot.record(1, now)
    assert not slot.room(1, now)
    assert slot.next_free(now) > now


def test_latex_tables_become_readable_rows():
    latex = (
        r"\begin{tabular}{cc}\multicolumn{2}{c}{**SIN**}\\ "
        r"\multirow{2}{*}{COSR-NE} & 260 MW\\ Eólica & 15.179\\ \end{tabular}"
    )
    markdown = latex_table_to_markdown(latex)
    assert "| SIN |" in markdown
    assert "COSR-NE" in markdown and "multirow" not in markdown
    assert "15.179" in markdown


def test_a_table_of_contents_is_recognised():
    assert is_table_of_contents("1. OBJETIVO ..... 3\n2. CONCEITOS ..... 3\n3. PROCEDIMENTOS ..... 4")
    assert not is_table_of_contents("Controlar a tensão de 230 kV conforme os limites da tabela")


def test_chunks_carry_a_locator_and_never_split_a_table():
    table = "| a | b |\n| --- | --- |\n| 1 | 2 |"
    pages = [
        {
            "page_no": 6,
            "markdown": (
                "5.1 LIMITACAO DO FLUXO\n\nTexto do procedimento com detalhes suficientes"
                f" para virar um chunk de corpo.\n\n{table}"
            ),
            "blocks": [],
        }
    ]
    chunks = chunk_pages(pages)
    assert any(chunk.locator.get("table") == "table" for chunk in chunks)
    assert all(chunk.locator.get("page") == 6 for chunk in chunks)
    assert any((chunk.section_path or "").startswith("5.1") for chunk in chunks)


def test_a_flattened_table_page_is_sent_to_the_vision_model():
    """The text layer of an operating instruction is columns, not rows."""
    from wattsteer_rag.parse import looks_tabular

    tabular = "\n".join(
        [
            "Passo     Coordenação      Controle        Procedimento",
            "1         COSR-NE          COSR-NE         Controlar a tensão de 230 kV",
            "          PSNB ≤ 260 MW    VSNB ≥ 230 kV   -",
            "2         COSR-NE          COSR-NE         Monitorar a inequação",
            "          PSNB ≤ 280 MW    VSNB ≥ 237 kV   -",
            "3         COSR-NE          COSR-NE         Acionar o esquema",
        ]
    )
    prose = "\n".join(
        [
            "A perturbação teve início às 08h30min do dia 15 de agosto de 2023.",
            "O relatório descreve a sequência de eventos registrada pelos agentes.",
            "As providências foram encaminhadas aos agentes envolvidos na análise.",
            "O documento consolida as contribuições recebidas no prazo estabelecido.",
            "A metodologia segue o submódulo aplicável dos Procedimentos de Rede.",
            "As conclusões constam do capítulo final deste relatório.",
        ]
    )
    assert looks_tabular(tabular)
    assert not looks_tabular(prose)


def test_a_table_keeps_the_heading_that_names_it():
    """The limits of section 5.4 are a table, and the only sentence that says
    which line they belong to is the heading right above it. Split apart, the
    heading is too short to stand and gets glued to the previous section, and
    the table becomes numbers nobody can attribute."""
    from wattsteer_rag.chunk import chunk_pages

    table = "| Limite | Valor |\n| --- | --- |\n| Normal | 1200 MW |"
    pages = [
        {
            "page_no": 7,
            "markdown": (
                "## 5.3. LIMITACAO ANTERIOR\n\nTexto da secao anterior, longo o bastante"
                " para virar um chunk de corpo por si so, com mais de duzentos e oitenta"
                " caracteres de conteudo real para nao ser absorvido por ninguem e assim"
                " exercitar exatamente o caminho que interessa aqui.\n\n"
                "## 5.4. LIMITACAO DA TRANSMISSAO NA LT 500 KV ACU III\n\n" + table
            ),
            "blocks": [],
        }
    ]
    chunks = chunk_pages(pages)
    with_table = [c for c in chunks if c.locator.get("table") == "table"]
    assert with_table, "the table must still be locatable as a table"
    assert "5.4. LIMITACAO DA TRANSMISSAO" in with_table[0].text
    assert not any(
        "5.4. LIMITACAO DA TRANSMISSAO" in c.text and "5.3. LIMITACAO ANTERIOR" in c.text for c in chunks
    ), "the heading of 5.4 must not end up inside the chunk of 5.3"


def test_a_page_of_actions_with_their_deadlines_is_not_a_table():
    """Measured on 22/09/2026: page 396 of the RAP of 15/08/2023 lists six
    actions, each followed by "Prazo: 30/03/2024      Gestor: EGE". The gap
    between the two fields read as a column, the page went to the vision model,
    and it returned the six actions as prose and the deadlines as a separate
    five-row table ("Praco: 30/07/2024" among them): which deadline belongs to
    which action was gone, and the question about 9.1.1's deadline was answered
    without one. The text layer had it right. Over every stored page this moves
    24 RAP pages, all of them lists of actions, and no operating instruction."""
    from wattsteer_rag.parse import looks_tabular

    actions = "\n\n".join(
        f"9.1.{n}      Avaliar os ajustes das Proteções de Perda de Sincronismo da LT 500 kV\n"
        f"           Bacabeira – Parnaíba III C1 e C2.\n\n"
        f"           Prazo: 30/0{n}/2024                            Gestor: EGE"
        for n in range(1, 7)
    )
    assert not looks_tabular(actions)


def test_the_answer_after_a_reasoning_block_is_the_json():
    """Measured on 22/09/2026: Gemma 4 on Google AI Studio writes its reasoning
    as "<thought>...</thought>" before the JSON, and the API refuses both knobs
    that would turn it off ("Thinking budget is not supported for this model").
    The reasoning quoted the JSON it was about to write, braces and all, so
    reading from the first brace to the last parsed nothing."""
    from wattsteer_rag.gateway.adapters import _json_from_text

    answer = (
        '<thought>* Word: "Saudade".\n* `{"ok": true, "word": "Saudade"}`\n'
        '* Valid JSON? Yes.</thought>{"ok": true, "word": "Saudade"}'
    )
    assert _json_from_text(answer) == {"ok": True, "word": "Saudade"}
    assert _json_from_text('<think>plan {x}</think>\n{"a": 1}') == {"a": 1}


def test_only_a_reasoning_block_that_opens_the_answer_is_removed():
    """Review of this change: the first rule removed everything up to the last
    closing tag anywhere, so a claim that quoted "</think>" lost its answer, for
    every model. And a block that never closes is a draft cut by the token
    limit; the JSON inside it was never given as the answer."""
    from wattsteer_rag.gateway.adapters import ProviderError, _json_from_text

    assert _json_from_text('{"claim": "a </think> b"}') == {"claim": "a </think> b"}
    assert _json_from_text('<think>x</think>{"claim": "tag </think> seen"}') == {"claim": "tag </think> seen"}
    with pytest.raises(ProviderError):
        _json_from_text('<thought>draft: {"ok": false, "draft": 1}')


def test_payment_required_is_a_refusal_not_a_quota(config, monkeypatch):
    """Measured on 22/09/2026: a Cerebras account without a card answers 402 to
    every request. Read as a spent quota it would be retried on every key every
    minute and reported as a delay; the configuration is what is wrong, and the
    run says so."""
    import asyncio

    from wattsteer_rag.gateway.adapters import ProviderError
    from wattsteer_rag.gateway.router import ProviderRefused

    gateway = Gateway(config)

    async def pay_first(*_args, **_kwargs):
        raise ProviderError("payment required", status=402)

    for provider in gateway.providers.values():
        monkeypatch.setattr(provider.adapter, "chat", pay_first)
    with pytest.raises(ProviderRefused, match="402"):
        asyncio.run(gateway.run("generate_strong", tokens=10, messages=[]))
    assert all(slot["state"] != "cooling" for slot in gateway.ledger.snapshot())
