# Brief de execução F1 para o Kimi K3: `apps/rag` do WattSteer (gateway + ingestão)

Você vai implementar a fase F1 do RAG de evidência do ONS dentro do monorepo WattSteer. Leia antes: `docs/plano-rag-v0.2.md` (arquitetura e decisões), `docs/rag/gateway.yaml`, `docs/rag/*.schema.json`, e no repositório `apps/ml/` (padrão de serviço Python), `apps/api/src/api/ml-proxy.ts`, `apps/api/src/jobs/retrain.ts`, `docker-compose.yml`, `.railway/railway.ts`, `test/database-gated-suite.test.ts`. Não mexa em `apps/api/src/diagnosis/*` nem em `apps/web` nesta fase.

## Regras inegociáveis

1. Nada de chamada direta a provedor no código de negócio: tudo passa por `wattsteer_rag/gateway`.
2. O gateway respeita limites por (provider, model) com contadores no Redis, faz pré-voo por tokens, e ao receber 429/5xx/timeout/JSON inválido passa ao próximo elo **com o mesmo payload**. Sem cota em nenhum elo: o job vai para `waiting_quota` com `retry_at`; nunca lança erro para o usuário.
3. `embed` nunca troca de modelo (bge-m3 em todos os elos); coluna `embedding_model` obrigatória; teste que recusa mistura.
4. Todo trabalho pesado é job em background (`arq` no Redis) com estado durável em `rag.job` e progresso legível (`feedback.message` em PT-BR).
5. Erros no envelope do repo: `{error:{code,message,details,request_id}}`; códigos novos `RAG_NOT_CONFIGURED`, `RAG_UNAVAILABLE`, `RAG_JOB_UNKNOWN`, `RAG_JOB_IN_PROGRESS` (409), `RAG_QUOTA_EXHAUSTED` (usado só em `/internal/llm/*`).
6. Idempotência: crawler por sha256 + manifesto; reexecutar nunca duplica. `job_id = sha256(kind + params normalizados)`.
7. Python 3.12, uv, ruff, mypy, pytest, como o `apps/ml`. Sem dependências AGPL (PyMuPDF4LLM fora). Docling (MIT) para PDF, `httpx` para HTTP, `openai` para os endpoints OpenAI-compatíveis, `asyncpg`, `pydantic-settings` (prefixo `WATTSTEER_RAG_`), `arq`, `tiktoken`, `pyyaml`, `jsonschema`. `sentence-transformers` só no extra `local`.
8. Logs estruturados (JSON) com `trace_id`; nunca logar corpo de resposta de provedor nem chaves.
9. Commits pequenos, mensagem em uma frase que diz o que mudou e por quê (estilo do repo). Sem co-autoria.

## Entregas (ordem)

### T1.1 Esqueleto
- `apps/rag/pyproject.toml`, `src/wattsteer_rag/{app.py,config.py}`, `Dockerfile` + `docker-entrypoint.sh` copiados e adaptados do `apps/ml`, `README.md` curto.
- `app.py`: `GET /health` (processo vivo), `GET /ready` (Postgres alcançável, schema `rag` migrado, Redis alcançável, `gateway.yaml` válido; devolve o que falta).
- Serviço `rag` no `docker-compose.yml` (depende de postgres e redis healthy, volume `rag-store` para documentos brutos) e no `.railway/railway.ts` (mesmo padrão do `ml`, `rootDirectory: apps/rag`, healthcheck `/health`).
- `apps/api/.env.example` ganha as variáveis do RAG e as que faltam da voz (`XAI_API_KEY`, `GROK_VOICE_MODEL`, `GROK_VOICE`, `WATTSTEER_RATE_LIMIT_VOICE`, `WATTSTEER_EDGE_CLIENT_IP_HEADER`, `WATTSTEER_JOB_LOCK_DURATION_MS`, `WATTSTEER_RETRAIN_PATTERN`, `WATTSTEER_OPEN_METEO_KEY`, `WATTSTEER_OPEN_METEO_MAX_UNITS`).
- Variáveis do RAG: `WATTSTEER_RAG_DATABASE_URL` (role `wattsteer_rag`, escrita só no schema `rag`), `WATTSTEER_RAG_REDIS_URL`, `WATTSTEER_RAG_STORE_DIR` (ou `WATTSTEER_RAG_S3_BUCKET`), `WATTSTEER_RAG_GATEWAY_CONFIG` (caminho do yaml), `NVIDIA_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `SAMBANOVA_API_KEY`, `WATTSTEER_RAG_LOCAL_URL`, `WATTSTEER_RAG_PORT` (8082).

### T1.2 Gateway (`wattsteer_rag/gateway/`)
- `config.py`: carrega e valida o yaml contra `llm-gateway-config.schema.json`; expande `${VAR:-default}`; valida invariantes (provedores referenciados existem; embed com um único modelo; elos `enabled=false` são ignorados).
- `limits.py`: contadores Redis por `(provider, model)`: janelas deslizantes de 60 s (rpm, tpm) e diária com reset à meia-noite `America/Sao_Paulo` (rpd, tpd); `budget_usd_day` para elos pagos com preço por token configurável; `cooling_until`; `has_room(estimated_tokens)`; `record(tokens_in, tokens_out)`.
- `router.py`: `run(task, payload) -> Result`: pré-voo (tiktoken `cl100k_base` como aproximação), escolha do primeiro elo com folga, chamada pelo adapter, validação (JSON contra schema quando `require.json_schema`), registro em `rag.llm_call`, fallback; `on_exhausted` conforme a tarefa. `Result` traz `provider, model, attempt, latency_ms, tokens_in, tokens_out, source ∈ {model, template, skipped}`.
- `adapters/openai_compatible.py`: chat completions (com `response_format` json_schema quando suportado, senão instrução no system + validação), embeddings, rerank (NVIDIA usa `POST {rerank_base_url}/{model}/reranking` com `{model, query:{text}, passages:[{text}]}`; Groq não tem rerank). `adapters/local.py`: mesma interface apontando para `base_url` local. `adapters/template.py`: devolve o template determinístico.
- Endpoints internos OpenAI-compatíveis: `POST /internal/llm/v1/chat/completions` (aceita `x-wattsteer-task: generate_strong|generate_small|narrate`), `POST /internal/llm/v1/embeddings`, `POST /internal/llm/v1/rerank`, `GET /internal/llm/quota` (por elo: usado/limite em cada janela, estado `ok|cooling|exhausted|disabled`, `next_reset`).
- Testes (`tests/gateway/`): servidor HTTP falso que responde 429 com `Retry-After`, 500, timeout e JSON inválido; asserts: troca de elo com payload idêntico (comparar bytes), contadores corretos, `waiting_quota` quando tudo esgota, embed recusa modelo diferente, `quota` reflete o estado.

### T1.3 Migrações (`src/wattsteer_rag/migrations/*.sql`, aplicadas por `wattsteer-rag migrate`)
- `0001`: `CREATE SCHEMA rag; CREATE EXTENSION IF NOT EXISTS vector;`
- `rag.source` (id, name, kind, base_url, schedule, license), `rag.document` (id uuid, source_id, external_id, url, title, published_at, fetched_at, sha256, bytes, mime, status ∈ {fetched, parsed, chunked, indexed, failed}, needs_review bool, meta jsonb), `rag.page` (document_id, page_no, markdown, has_tables, ocr_used), `rag.chunk` (id, document_id, page_start, page_end, section_path, locator jsonb, text, tokens, embedding vector(1024), embedding_model text not null, tsv tsvector generated always as (to_tsvector('portuguese', text)) stored), índices HNSW cosine e GIN, `rag.bdo_balanco`, `rag.bdo_despacho_termico`, `rag.bdo_producao_usina`, `rag.bdo_transmissao` (tabelas do BDO, colunas conforme o HTML; guardar também `raw_html_sha256`), `rag.job` (schema de `rag-job-status.schema.json` em colunas + `payload jsonb`), `rag.llm_call`, `rag.retrieval_log`.
- Teste `tests/test_migrations.py` gated por `WATTSTEER_TEST_DATABASE_URL`; script `test:db` no `package.json` do `apps/rag` (sim, um `package.json` mínimo para o `bun run --cwd apps/rag test:db` existir, como o hygiene test exige) que roda `migrate` e depois `pytest`.

### T1.4 Crawler (`wattsteer_rag/crawl/`)
- `sources.yaml` com as fontes da seção 2 do plano. `store.py`: grava bruto em `WATTSTEER_RAG_STORE_DIR/<source>/<sha256>.<ext>` + manifesto em `rag.document`.
- `bdo.py`: para cada dia de D-730 até hoje: `GET https://sdro.ons.org.br/SDRO/DIARIO/AAAA_MM_DD/index.htm`; se 200, baixar `PDF/DIARIO_DD-MM-AAAA.pdf`, `Html/DIARIO_DD-MM-AAAA.xlsx` e as 17 páginas `HTML/NN_*.html`; fins de semana/feriados podem não existir (404 não é erro). Intervalo mínimo 1 s entre requests, `User-Agent: WattSteer-RAG/0.1 (+https://www.wattsteer.com)`.
- `procedimentos.py`: renderizar `https://www.ons.org.br/paginas/sobre-o-ons/procedimentos-de-rede/vigentes` com Playwright (chromium headless) e coletar os `a[href*="retornarpdf"]`; filtrar por lista configurável (Submódulos 4.2, 4.5, 6.7, 6.9, 22.3; Módulo 10); baixar a versão mais recente de cada (`-RS_` e `-PR_`), guardar `version` extraída do nome.
- `ipdo.py` / `rap.py`: Playwright em `documentos-e-publicacoes?categoria=IPDO|RAP`; esperar a lista renderizar (`a[href$=".pdf"]` que não seja `POL.PRV`), coletar título/url/data; IPDO = snapshot diário (documento novo por dia mesmo que a URL repita). Se em 60 s não renderizar, registrar `FETCH_RENDER_TIMEOUT` e seguir.
- `ons_parquet.py` (substitui o `ckan.py`): ingestão **direta do S3 público** `s3://ons-aws-prod-opendata/dataset/<pasta>/*.parquet` (anônimo, `union_by_name`) para tabelas `rag.ons_*`, com os contratos obtidos do MCP TIAGO (`descrever_dataset`) salvos em `crawl/contracts/*.yaml` no repo (colunas, casts `TRY_CAST(... AS DOUBLE)` para os campos exportados como VARCHAR, fuso `America/Sao_Paulo`). Datasets: `interrupcao_carga`, `programacao_fluxo_controlado`, `classificacao_evt`, `disponibilidade_usina_ho`, `ind_disponibilidade_ft_trlt_me`. Idempotente por arquivo (ETag/sha256 do Parquet). Não chamar o MCP em runtime; ele é ferramenta de desenvolvimento (`https://mcp.dados.tiago.ons.org.br/`, sem auth, `executar_sql` com `read_parquet(...)`) e, opcionalmente, um `provider.kind: mcp` do gateway para consultas ad hoc com fallback.
- Job `crawl` com progresso por fonte e por item; `partial` quando houve 4xx/5xx em itens individuais.

### T1.5 Parser e chunker
- `parse/docling_parser.py`: PDF → Markdown por página com tabelas; OCR (RapidOCR, `pt`) só se a página não tiver texto extraível. `parse/bdo_html.py`: as 17 tabelas HTML → linhas nas tabelas `rag.bdo_*` (pandas `read_html` é aceitável) + um chunk por tabela com cabeçalho e as linhas em Markdown (para o retrieval textual).
- `chunk/chunker.py`: por cabeçalho de seção, 400 a 800 tokens, overlap 10 %, tabelas nunca partidas; `locator` = `{page, section, table, row}`; `section_path` derivado dos headings.
- `chunk/metadata.py`: por documento, `generate_small` com schema `{tipo_documento, data_evento, subsistemas[], estados[], equipamentos[], agentes[], causa_declarada, janela_horaria}`; duas tentativas; falha → `needs_review=true` e meta vazia, nunca bloqueia.

### T1.6 Indexação
- `index/embed.py`: lotes de 32 pelo gateway `embed`; grava `embedding`, `embedding_model`; retomável (só chunks sem embedding).
- Job `index` com `progress.total` = chunks pendentes; `waiting_quota` quando o gateway pedir; relatório final em `result` (documentos, chunks, tokens, custo estimado, tempo).
- `GET /internal/rag/status`: documentos por fonte e status, chunks, última ingestão, versão do corpus (`corpus_version = data + n_docs + sha256 do manifesto`), quota do gateway.

## Definição de pronto da F1
- `docker compose up` sobe `rag` saudável; `/ready` verde com Postgres e Redis; `bun run check` do repo continua verde (hygiene inclusive).
- `POST /internal/rag/jobs {kind: crawl, params: {source: bdo, days: 730}}` → 202 → `GET /internal/rag/jobs/{id}` mostra progresso e termina `succeeded|partial` com contagens.
- `crawl` + `parse` + `index` de BDO (24 meses) e Procedimentos concluídos; `status` reporta cobertura; `quota` reflete uso real.
- Suíte `tests/gateway` passa sem rede; suíte gated passa com `test:db`.
- Nenhuma chave em commit; `.env.example` completo.
