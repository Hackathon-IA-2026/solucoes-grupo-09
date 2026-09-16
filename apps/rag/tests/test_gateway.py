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
