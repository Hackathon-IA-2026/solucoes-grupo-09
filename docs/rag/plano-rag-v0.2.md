# WattSteer RAG de evidência do ONS: plano v0.2 (15/09/2026, 20h)

Substitui `plano-rag-v0.1.md`. O que mudou: corpus definido e URLs verificadas; pesos e regras do Bisogno absorvidos; alinhamento com os 98 commits novos do repositório (12 a 15/09); decisão de repositório; perguntas-ouro avaliadas; MCP TIAGO avaliado.

**Quem faz e onde roda (fixado em 15/09 à noite):** o desenvolvimento é feito no **Claude Code, pelo Guilherme com o Claude**, em branches + PR (nunca na `main`). O Kimi **não** é agente de desenvolvimento: é candidato a modelo **dentro do produto** via NVIDIA NIM (`moonshotai/kimi-k3`, forte e pesado; `moonshotai/kimi-k2.6`, mais leve), onde for viável. **Restrição de runtime: só modelos abertos, nas infras AWS (Bedrock com modelos abertos), NVIDIA (NIM) e Groq.** Não haverá Claude nem provedor fechado na nuvem. Consequências: (1) a narração do `apps/api`, que hoje chama o SDK da Anthropic, **migra obrigatoriamente** para o gateway (F3, sem tocar nos gates); (2) a voz (xAI Grok, fechado) precisa de substituto aberto (ex.: STT/TTS abertos + Nemotron) ou fica fora da demo, decisão do Vitor; (3) o "elo pago de emergência" recomendado pelo Bisogno passa a ser o **Bedrock com modelos abertos** dentro dos créditos da organização, não OpenAI.

## 0. Decisão de repositório

**Um monorepo só: o `vtorres/WattSteer` que já existe.** O `apps/rag` nasce dentro dele. Publicação final: espelhar o `main` no `Hackathon-IA-2026/solucoes-grupo-09` (repo privado da organização, MIT, criado em 14/09, só com README-modelo), **somente quando o Guilherme mandar** (nada é publicado agora).

Por quê:
- O WattSteer já é monorepo Bun workspaces (`apps/api`, `apps/ml`, `apps/web`, `packages/core`, `packages/ui`), 1.235 arquivos, 13,4 MB de pack, com contratos compartilhados TS/Python em `packages/core/schema` + fixtures golden, `docker-compose` com todos os serviços, IaC da Railway em `.railway/railway.ts` e 15 testes de invariante que atravessam os apps. Um repo separado para o RAG duplicaria compose, config, contratos e CI, e quebraria a regra do repo de que o `apps/api` é a única porta pública.
- O README já está no formato exigido pelo modelo da organização (Demo, Tecnologias, Como rodar, Pré-requisitos, Licença) e a LICENSE é MIT em nome de "Hackathon-IA-COPPE-2026" (commit `50a08b1`). O Vitor claramente preparou o repo para ser o entregável.
- O regulamento exige repo público MIT só para o código do Hackathon (25 a 27/09). Espelhar o histórico inteiro no repo da organização atende isso e mantém a propriedade do produto com o Vitor.

Como trabalhar até lá:
- Guilherme (e quem mais for codar) entra como colaborador do `vtorres/WattSteer`; trunk-based, branches curtas `rag/<tema>`, PR pequeno, `bun run check` verde antes do merge. `bun run preflight` já recusa começar trabalho com base atrás de `origin/main`.
- `CODEOWNERS`: `apps/rag/` para o Guilherme; `apps/ml/` e `apps/api/` para o Vitor; `docs/` livre.
- Remote adicional local: `git remote add hackathon https://github.com/Hackathon-IA-2026/solucoes-grupo-09.git` (só quando for publicar: `git push hackathon main`). Antes do push, revisar o README (trocar `git clone` para a URL da organização) e conferir que nenhum `.env` ou chave está no histórico.
- Alternativas rejeitadas: repo separado `wattsteer-rag` (integração e contratos duplicados em 10 dias), submódulo git (péssimo para avaliador clonar), desenvolver direto no repo da organização (privado, controlado por eles, "não publica nada agora").

## 1. Estado do repositório que o RAG precisa respeitar (15/09, `4d6b4d2`)

- **"Gateway" = `apps/api`** (Elysia). Única porta pública; `apps/ml` nunca é exposto. O `apps/rag` segue a mesma regra: interno, acessado só pelo `apps/api` via proxy (padrão `ml-proxy.ts`, com `AbortController` próprio e `timeout_source`).
- **Capacidade opcional com flag no `/v1/meta`**: a voz (xAI) só aparece na UI se `meta.voice.configured` for `true` (`apps/api/src/api/meta.ts`, `packages/core/schema/meta.schema.json`). Replicar: `meta.rag.configured` + `meta.rag.corpus` (documentos, chunks, última ingestão).
- **Dois códigos de recusa por capacidade**: `VOICE_NOT_CONFIGURED` (ausente) vs `VOICE_UNAVAILABLE` (quebrada), corpo do upstream nunca logado. Replicar: `RAG_NOT_CONFIGURED`, `RAG_UNAVAILABLE`, `EVIDENCE_NOT_YET_PUBLISHED` (404).
- **Job longo = 202 + polling** (retrain, forecaster 45): `POST` devolve `run_id` na hora; `GET /{run_id}` devolve `running | decided | failed`; mesmo id em voo = 409 "anexe e continue"; serviço reiniciado = 404 honesto; o worker BullMQ faz polling com backoff 2 s a 30 s e `report({done,total})`. Replicar para `POST /internal/rag/ingest` e `GET /internal/rag/jobs/{id}`, **mas com estado durável em `rag.job` no Postgres** (o retrain usa dict em memória porque a decisão é idempotente no `promotions.jsonl`; ingestão não tem esse luxo).
- **Testes de invariante**: `reachability.ts` só varre `apps/api`, `apps/web`, `packages`, `scripts` (Python fora, como o `apps/ml`); `database-gated-suite.test.ts` só cobre `apps/api/test` (replicar o mesmo contrato para `apps/rag/tests`: variável `WATTSTEER_TEST_DATABASE_URL`, script `test:db` que roda `db:migrate`); `gateway-imports-core` exige `@wattsteer/core` no `package.json` e no Dockerfile de quem importa; `phantom-schedules` exige que todo cron documentado exista no código.
- **Deploy**: `docker-compose.yml` (5 serviços) e `.railway/railway.ts` (4 serviços + Postgres + Redis + volumes + bucket). Serviço novo tem que entrar nos dois. `apps/ml/Dockerfile` + `docker-entrypoint.sh` (chown do volume, `setpriv`) é o modelo para o `apps/rag`.
- **LLM hoje**: narração via `@anthropic-ai/sdk` direto em `narration-client.ts` (sem adapter); voz via `fetch` para `api.x.ai` em `voice.ts` (sem adapter). `.env.example` está desatualizado (faltam `XAI_API_KEY`, `GROK_VOICE_MODEL`, `WATTSTEER_RATE_LIMIT_VOICE`, `WATTSTEER_EDGE_CLIENT_IP_HEADER`, `WATTSTEER_JOB_LOCK_DURATION_MS`, `WATTSTEER_RETRAIN_PATTERN`, `WATTSTEER_OPEN_METEO_KEY`).
- **Modelo promovido: nenhum** (rail `p10_calibration_excess` veta; forecaster 46 conclui que o gap não tem causa corrigível no módulo). A Visão da rede responde de dados "settled" sem P10/P50/P90. Isso importa: no dia da demo pode não haver diagnóstico publicado, então a rota de evidência precisa funcionar **também sem diagnosis** (entrada = subsistema + data, não só o diagnóstico).
- **Voz** tem tool calling (`show_grid`, `explain`, `mitigate`, `replay`, `focus`, `highlight`). Uma tool `evidence` é candidata natural depois que o RAG existir (fase 4, não antes).

## 2. Corpus definitivo (Bisogno, 15/09) com URLs verificadas por mim

| Fonte | Como acessar (verificado 15/09) | Formato | Janela | Serve para |
|---|---|---|---|---|
| **BDO** Boletim Diário da Operação | Raiz `sdro.ons.org.br/` dá 403, mas as pastas diárias respondem: `https://sdro.ons.org.br/SDRO/DIARIO/AAAA_MM_DD/index.htm` com `PDF/DIARIO_DD-MM-AAAA.pdf`, `Html/DIARIO_DD-MM-AAAA.xlsx` e **17 tabelas HTML** (`HTML/01_RelBalancoEnergeticoDiario.html` ... `10_ProducaoEolicaUsina`, `11_ProducaoSolarUsina`, `12_MotivoDespachoTermico`, `17_IntegrantesTransmissaoSIN`). Publicado a partir das 15h em dias úteis; segunda traz sex/sáb/dom. Semanal em `/SDRO/semanal/` | HTML + PDF + XLSX | 24 meses | ENE (balanço, motivo de despacho), CNF (intercâmbio, integrantes da transmissão) |
| **IPDO** Informativo Preliminar Diário | Listagem `https://www.ons.org.br/paginas/conhecimento/acervo-digital/documentos-e-publicacoes?categoria=IPDO` (renderizada por JS, sem XHR visível em 12 s: usar Playwright ou descobrir a REST do SharePoint). **Não preserva histórico**: snapshot diário obrigatório | PDF | 12 meses (a partir de agora) | ENE, REL (texto do dia) |
| **RAP** Relatório de Análise de Perturbação | Listagem `...documentos-e-publicacoes?categoria=RAP` (mesma mecânica JS). O de 15/08/2023 é a referência do Bisogno. A URL `AcervoDigitalDocumentsEPublicacoes/` que ele passou dá 404 (a grafia certa é `AcervoDigitalDocumentosEPublicacoes/`) | PDF | 2023 a 2026 | REL/CNF em eventos grandes |
| **Procedimentos de Rede** (Submódulos 4.2, 4.5, 6.7, 6.9; Módulo 10) | Página `https://www.ons.org.br/paginas/sobre-o-ons/procedimentos-de-rede/vigentes` lista 419 PDFs via `https://proxyportais.ons.org.br/ons.portalempregado.proxy/garapi/api/processo/retornarpdf?url=/sites/soumaisons/portalgar/ecmpdf/Submódulo%204.2-RS_2024.07.pdf`. Encontrados: 4.2-RS_2024.07 e 4.2-PR_2023.12; 4.5-PR_2025.02 e 4.5-RS_2024.10; 6.7-RS_2026.04 (Retificado) e 6.7-PR_2025.06; 6.9-RS_2025.02 e 6.9-PR_2025.02. Submódulo 22.3 e Módulo 10 não apareceram no filtro: conferir nome exato na listagem | PDF | vigentes | Regras citáveis (critério de VETO do Bisogno) |
| **ONS Dados Abertos** (CKAN) | `https://dados.ons.org.br/api/3/action/package_search?q=...`. **Não existe dataset de cronograma de intervenções** (`intervencao` = 0 resultados). Existem: `ind_disponibilidade_ft_trlt` (disponibilidade de linhas de transmissão, mensal, 50 recursos), `ind-disponibilidade-geracao-sin`, `taxa_teif_teip*`, e os `restricao_coff_*` já usados pelo modelo | CSV/Parquet | 2024+ | CNF/REL como **tabela**, não como chunk |
| **SIGA/ANEEL** | `https://dadosabertos.aneel.gov.br/`; chave `IdeNucleoCEG` (o repo já usa o núcleo do CEG) | CSV | atual | Metadados de usina |
| Normas já em mãos | RT DGL 0189/2025, NT DOP 0022/2025, NT DGL 0124/2025, REN ANEEL 1.030/2022, Lei 15.269/2025 (PDFs em `hackathon/docs` e resumos em `resumo-ons-rt-nt.md`) | PDF | | Regras citáveis (§7.1, §5.1.2) |

### 2.1 TIAGO: o MCP de dados abertos do ONS (avaliado em 15/09, 20h40)

O ONS publicou um assistente de IA ("Tiago Dados Abertos", `https://dados.tiago.ons.org.br/`) e um **servidor MCP público, sem autenticação, Streamable HTTP**: `https://mcp.dados.tiago.ons.org.br/` (instruções em `https://dados.ons.org.br/mcp`; `claude mcp add --transport http ons-tiago-dadosabertos https://mcp.dados.tiago.ons.org.br/`). Servidor "MCP TIAGO Dados Abertos - ONS" v1.0.1, 4 tools: `listar_datasets` (76 datasets com granularidade e perspectiva), `buscar_dataset(tema)` (BM25 sobre os contratos), `descrever_dataset(nome_dataset)` (contrato ODCS: colunas, tipos, `TRY_CAST` para os campos exportados como VARCHAR, SQL de exemplo, armadilhas), `executar_sql(sql_query, limit, offset)` (DuckDB read-only; as tabelas **não** existem por nome: usar `read_parquet('s3://ons-aws-prod-opendata/dataset/<pasta>/*.parquet', union_by_name=true)`, a pasta vem no campo `parquet_source` do contrato).

Medições: `listar/buscar/descrever` em 1,3 a 1,7 s; SQL leve 2 a 4 s; agregação de 4 meses de constrained-off eólico 20 s; varredura completa de `programacao_fluxo_controlado` 61 s → **504** do CloudFront. Sem limite publicado, sem SLA.

Como usar (decisão):
1. **Catálogo e contratos, sim, agora.** O TIAGO substitui o `ckan.py` do crawler para dados estruturados: os contratos dizem colunas, casts e caminhos S3; o `apps/rag` (e o `apps/api`, que já lê o mesmo bucket) ingere os Parquet **direto do S3**, não pelo MCP. Datasets que o WattSteer ainda não ingere e que viram evidência estruturada: `interrupcao_carga` (2007 a 14/09/2026, 8.331 eventos, `cod_perturbacao` que liga ao RAP, agente, MW interrompidos, flags de Rede Básica) → REL/RAP; `programacao_fluxo_controlado` (30 min, limites programados de fluxo em 40 elementos controlados por submercado; atualizado até 15/09/2026, `din_programacaodia` no formato `AAAA-MM-DD`, valores de `cod_submercado` a conferir no contrato) → **CNF programado para D-1**; `classificacao-evt` (EVT horária separada em razão energética vs elétrica no SIN; **termina em 31/12/2025**, decimais com vírgula em VARCHAR) → ENE histórico; `disponibilidade_usina` (horária, hidro e térmica); `ind_disponibilidade_ft_trlt` (mensal, só 18 classes de equipamento, 2011 a 08/2026: contexto fraco para REL, não é cronograma).
2. **Runtime do produto, não.** Nada do caminho D-1 depende do MCP (latência variável, 504 em varreduras, sem garantia). O gateway pode registrar o TIAGO como `provider.kind: mcp` para consultas ad hoc na demo (tool `consultar_dados_ons` do Evidence Builder e, na fase 4, da voz), sempre com fallback para as tabelas locais.
3. **Posicionamento no pitch:** o próprio ONS agora responde "o que aconteceu" sobre os dados abertos; o WattSteer diz "o que vem amanhã, por quê e com que evidência". Citar o TIAGO como fonte oficial reforça a credibilidade e evita a pergunta "por que não usar o do ONS?".

### 2.2 Blueprints da NVIDIA (avaliados em 15/09, 21h)

`build.nvidia.com/blueprints` tem 32 blueprints; quatro tocam o nosso problema. Todos os repositórios são abertos (`github.com/NVIDIA-AI-Blueprints/*`).

| Blueprint | Licença | Roda sem GPU? | Decisão |
|---|---|---|---|
| **rag** (766 estrelas) | Apache-2.0 | Sim, no modo "NVIDIA hosted endpoints" (só chave `nvapi-`) | **Aproveitar as peças, não o produto.** Traz Elasticsearch (padrão) ou Milvus, servidor de ingestão, servidor de RAG e UI próprios: colide com a fronteira "Postgres é a única fonte de verdade" e com o nosso contrato de evidência. O que vale ouro são os **NIMs de extração de PDF** que ele usa (ver abaixo). |
| **aiq** (866 estrelas) | Apache-2.0 | Sim: "usando o NVIDIA API Catalog (padrão), não há requisito de GPU local" | **Referência, não adoção.** É um agente de pesquisa profunda com relatório citado; a documentação registra que ele "falha fechado" quando o modelo devolve rascunho com citação incompleta, exatamente a disciplina dos nossos gates. Ler a implementação da verificação de citação. |
| **nemotron-voice-agent** (225 estrelas) | BSD-2-Clause | Sim: perfil **Cloud = apenas CPU**, modelos pela nuvem da NVIDIA | **Candidato a substituir a voz do xAI**, que é fechada e não pode ir para a nuvem. ASR Parakeet/Nemotron streaming, TTS Magpie Multilingual ou Chatterbox Multilingual, LLM "qualquer OpenAI-compatível". Decisão do Vitor, dono da tela de voz. |
| **llm-router** (349 estrelas) | Apache-2.0 | Parcial (a parte multimodal quer um servidor CLIP com GPU) | **Só referência.** Roteia por complexidade da tarefa, não por cota; não faz pool de chaves nem fallback por limite, que é o nosso diferencial. |

**O que entra no nosso plano agora: os NIMs de extração de documento.** O blueprint de RAG usa, todos hospedados e no tier gratuito: `nvidia/nemotron-parse` (VLM de extração de texto e tabela de imagem de página), `nvidia/nemotron-ocr`, `nvidia/nemotron-page-elements-v3`, `nvidia/nemotron-table-structure-v1`, `nvidia/nemotron-graphic-elements-v1` e `baidu/paddleocr`. Para os PDFs do ONS (RAP escaneado, tabelas do BDO) isso resolve o ponto mais caro da ingestão sem consumir CPU da instância. Fica como **tarefa `parse` do gateway**, com cadeia `nemotron-parse (NIM) → Docling local`: se a cota acabar ou a página falhar, cai para o Docling e a ingestão continua. Mesma regra de sempre, adapter e fallback.

### 2.3 Teste com chave real do NIM (15/09, 21h30) e o que ele derrubou

Chave gerada pelo Guilherme, guardada em `WattSteer/.env` (ignorado pelo git, permissão 600). 82 modelos disponíveis. Três resultados mudam o plano:

1. **A NVIDIA aposentou os embedders que estavam no plano.** `baai/bge-m3`, `nvidia/llama-nemotron-embed-1b-v2` e `nvidia/nv-embedqa-e5-v5` responderam **410 Gone, fim de vida em 25/08/2026**; `llama-3.2-nv-embedqa-1b-v2` morreu em 18/05. O único embedder de texto vivo e adequado é **`nvidia/nemotron-3-embed-1b`**: 2048 dimensões (pode ser cortado para 1024 ou 512 renormalizando, estilo Matryoshka), contexto 32k, avaliado em 34 idiomas **incluindo português**, licença OpenMDW com pesos abertos (construído sobre Ministral-3-3B, Apache-2.0). Passa a ser o embedder primário, com dimensão **1024** para manter o índice pequeno.
   **Consequência honesta:** não existe fallback no mesmo espaço vetorial. Se o modelo sumir (a NVIDIA acabou de aposentar quatro de uma vez), a saída é um job `reindex` que reprocessa o corpus com `bge-m3` local, porque guardamos o texto de todo chunk. Isso é um procedimento declarado, não um fallback silencioso, e a coluna `embedding_model` existe para detectar mistura.
2. **Não há mais reranker no NIM.** `ai.api.nvidia.com/v1/retrieval/.../reranking` devolve 410 para `llama-nemotron-rerank-1b-v2` e 404 para os demais; nenhum modelo de rerank aparece na lista de 82. O rerank passa a ser **local (`BAAI/bge-reranker-v2-m3`, CPU)**, com `skip_rerank` (ordem do RRF, declarada no trace) quando faltar recurso.
3. **`nemotron-parse` validado com documento real do ONS.** Página 3 do BDO de 14/09/2026 (o PDF tem 58 páginas e **nenhuma camada de texto além do cabeçalho**: `pdftotext` não extrai nada de útil). Resultado: **2,2 s por página**, 574 tokens de saída, e blocos tipados (`Page-header`, `Text`, `Table`, `Page-footer`) com bbox normalizado. A tabela "Balanço de Energia Acumulado no Mês" saiu correta (Hidro 35.814, Eólica 15.179, Solar 12.910, Total SIN 80.382 MWmed). Detalhes de implementação: a resposta vem como `tool_call` chamado `markdown_bbox` com um array de blocos, e as tabelas vêm em **LaTeX `tabular`**, não em Markdown — o parser precisa converter. O bbox por bloco serve de `locator` da citação.

**Embeddings: decisão final.** Primário `nvidia/nemotron-3-embed-1b` (1024 dims, português, hospedado e gratuito); `bge-m3` local vira o caminho de reindexação, não elo de fallback. O `llama-nemotron-embed-vl-1b-v2` (multimodal) fica anotado para quando quisermos buscar por figura.

Consequência para o REL: sem cronograma público, **REL fica "não avaliável" por padrão (D09 / NA-01)** e o RAG entrega o que existir em texto (IPDO/BDO/RAP mencionando intervenção, desligamento, restrição na região) com `confidence` no máximo `medium`. Os pesos do Bisogno (REL 0,7 a 0,9; CNF 0,4 a 0,6; ENE 0,2 a 0,4) entram como **campo de exibição/confiança** (`evidence_weight`) no JSON, nunca como entrada do classificador ("Nenhuma regra muda um número").

Prioridade de ingestão: (1) BDO 24 meses (HTML estruturado, mais barato e mais útil), (2) Procedimentos de Rede vigentes, (3) RAP 2023 a 2026, (4) IPDO diário daqui para frente, (5) normas locais.

## 3. Perguntas-ouro: avaliação e o que fazer

As 20 do Bisogno (doc "Parecer Técnico", 15/09) servem como **smoke test de recuperação**, não como teste de evidência de curtailment: 3 são sobre o apagão de 15/08/2023 (RAP), 11 são meta-perguntas sobre os documentos (horário/formato/finalidade do BDO, "IPDO preserva histórico?") cuja resposta está na página institucional, não no corpus; Q20 está truncada; nenhuma traz página. Plano:
- Manter as 20 como `smoke.jsonl` (passa se cita o documento certo e não inventa número).
- Pedir ao Bisogno **(quando o Guilherme autorizar)** um segundo conjunto `evidence.jsonl` com 15 perguntas no formato do produto: "Em DD/MM/AAAA, subsistema X, houve restrição/intervenção/excedente registrado? Onde?" com documento, página e trecho. Metas: recall@8 do documento ≥ 0,9; página certa ≥ 0,8; claims sem citação = 0.

## 4. Arquitetura (o que muda em relação à v0.1)

Mantido: crawler idempotente → Docling (OCR condicional) → chunks por seção com tabelas inteiras → metadados por documento (LLM pequeno, JSON estrito) → **bge-m3** (1024 d) em **Postgres pgvector + tsvector('portuguese')** → híbrido RRF → rerank → Evidence Builder com 3 gates (citação literal, whitelist numérica, léxico causal via `findCausalityHits` do `packages/core`).

Ajustes:
1. **BDO entra como tabelas, não só como chunks.** As 17 páginas HTML diárias viram linhas em `rag.bdo_*` (balanço, motivo de despacho térmico, produção eólica/solar por usina, integrantes da transmissão). O Evidence Builder cita a tabela + data + linha. O PDF do BDO só é chunkado para o texto livre.
2. **Contrato de evidência acoplado ao alerta.** O schema do alerta que o Bisogno definiu (L-03: `regiao, risco, energia_MWh, causa_provavel, dias_parecidos, versao_dados, modelo, sha256, texto_operador{texto,fonte,modelo_llm}, hipoteses`) ganha o campo `evidencia_documental`: `{verdict, items[{claim, supports, confidence, evidence_weight, citations[{document_id, title, published_at, page|table, quote, url, sha256}]}], corpus_version, gateway_trace_id}`. Vai para `packages/core/schema/rag-evidence.schema.json` **[revisão]**.
3. **NA-01 explícito.** Sem documento aplicável, `verdict: not_found` com `reason` ("sem cronograma de intervenções público", "corpus sem cobertura da data"), nunca vazio.
4. **Precedência ao ordenar evidências:** REL ≻ {CNF, ENE}, desempate por duração (doc4 §3.2), e divergência com a regra é publicada e declarada (as duas), nunca escondida.
5. **Bitemporalidade também no corpus:** `rag.document` com `published_at`, `fetched_at`, `sha256`, `corpus_version`; replay de um dia D usa só documentos com `published_at ≤ gate_at(D)` (mesma disciplina do `gate_at` do modelo). IPDO/BDO com snapshot diário.
6. **Auditoria:** cada recuperação grava `rag.retrieval_log` (pergunta, filtros, ids dos chunks, scores, provedor/modelo, trace) e o sha256 dos trechos citados, para o replay reproduzir a mesma evidência. WORM/MinIO com Object Lock que o Bisogno propõe fica como "futuro"; no MVP, append-only no Postgres.
7. **Entrada sem diagnóstico:** `GET /v1/evidence/day-ahead?subsystem=NE&date=` funciona com subsistema + data (e usa SHAP/causa candidata só se houver diagnosis publicado), porque hoje não há modelo promovido.
8. **Texto para o operador** passa pelo dicionário T17 do Bisogno (sem "causou/porque/devido a", "observamos", ação primeiro) e pelo mesmo template determinístico como fallback.

Fora do escopo por decisão técnica (com o motivo, para responder ao Bisogno se ele perguntar):
- **Qdrant + Ollama** (proposta dele em L-09): o repo tem a fronteira "Postgres é a única fonte de verdade"; pgvector + tsvector cobrem híbrido em português sem um serviço a mais; Ollama num t3.medium (4 GB) não aguenta LLM útil. Embeddings/rerank vão pelo NIM (grátis) com fallback local só de embedding (bge-m3 int8 cabe em ~1,5 GB; se apertar, o fallback local roda no Mac do Guilherme durante a demo, ligado como provedor `local` no `gateway.yaml`). **[D-RAG-08]** tamanho da instância AWS: pedir t3.large/t3.xlarge se os créditos permitirem.
- **Cascata "Claude gratuito → Kimi K3 gratuito → OpenAI"** (L-10): Claude e OpenAI são fechados e não vão para a nuvem; Kimi K3 é pago na Moonshot mas está no NIM gratuito. A cadeia é NVIDIA Nemotron 3 Super → NVIDIA Kimi K3 → Groq gpt-oss-120b → OpenRouter nemotron:free → SambaNova → Bedrock (modelos abertos, teto US$ 5/dia, quando os créditos chegarem).

## 5. Gateway de provedores (inalterado na essência, com três acréscimos)

Ver v0.1 §3 para o `gateway.yaml` e o comportamento (contadores no Redis, pré-voo, fallback com o mesmo payload, `waiting_quota`, `rag.llm_call`, `/internal/llm/quota`). Acréscimos:
- **Pool de chaves do time (Guilherme, 15/09):** cada um dos 5 integrantes cria a própria chave na NVIDIA, no Groq, no OpenRouter e na SambaNova; as chaves entram em `NVIDIA_API_KEYS`, `GROQ_API_KEYS`... separadas por vírgula. O gateway trata cada chave como um slot com contadores e cooling próprios (`limits_scope: per_key`), escolhe a chave com mais folga (`least_loaded`) e só troca de provedor quando todas as chaves do elo esgotam. Chaves nunca aparecem em log, trace ou erro (só `key_id` = 8 hex do sha256). Efeito prático: 5 cotas de NIM e 5 organizações do Groq trabalhando juntas, com fallback entre elas. Cuidado: cada um cria a chave na própria conta, e a chave fica só no `.env` do deploy (nunca no repo nem no Discord).
- `provider.kind: local` também cobre um executor remoto na LAN (o Mac), via URL HTTP OpenAI-compatível (`text-embeddings-inference` ou `infinity`), para o fallback de embedding/rerank sem ocupar a instância.
- A narração atual (`narration-client.ts`) **não é tocada na F1/F2**. Na F3, o `NarrationMessages` (seam de DI que já existe) recebe uma implementação que fala com `/internal/llm/v1/chat/completions` do gateway, fechando D04 (Nemotron via NIM) sem mexer nos gates. A voz (xAI) fica como está.

## 6. Layout do `apps/rag`

```
apps/rag/
  pyproject.toml            # uv, python >=3.12,<3.13 (igual ao apps/ml); deps: fastapi, uvicorn, asyncpg, pydantic-settings,
                            # httpx, openai, docling, arq, tiktoken, rapidocr-onnxruntime (opcional), sentence-transformers (extra "local")
  Dockerfile + docker-entrypoint.sh   # copiados do apps/ml (chown do volume, setpriv)
  railway.json (não: entra em .railway/railway.ts)
  src/wattsteer_rag/
    app.py                  # FastAPI: /health, /ready, /internal/rag/{ingest,jobs/{id},query,status}, /internal/llm/v1/{chat/completions,embeddings,rerank}, /internal/llm/quota
    config.py               # pydantic-settings, prefixo WATTSTEER_RAG_ ; DATABASE_URL (read-write só no schema rag), REDIS_URL, chaves dos provedores
    gateway/{config.py,limits.py,router.py,adapters/{openai_compatible.py,local.py,bedrock.py}}
    crawl/{sources.yaml,bdo.py,ipdo.py,rap.py,procedimentos.py,ckan.py,store.py}
    parse/{docling_parser.py,bdo_html.py}
    chunk/{chunker.py,metadata.py}
    index/{embed.py,db.py}
    retrieve/{hybrid.py,rerank.py,rewrite.py}
    evidence/{builder.py,gates.py,schema.py}
    jobs/{worker.py,ingest.py}          # arq
    migrations/0001_rag_schema.sql ...  # só schema rag; CREATE EXTENSION vector
  tests/                    # pytest; suíte gated por WATTSTEER_TEST_DATABASE_URL com script test:db
  eval/{smoke.jsonl,evidence.jsonl,run_eval.py}
```

No `apps/api`: `src/api/evidence.ts` (rotas públicas, proxy tipado), `src/api/rag-proxy.ts` (cópia adaptada do `ml-proxy.ts`), códigos novos em `packages/core/src/errors.ts` + `error.schema.json`, `meta.rag` no `meta.schema.json`, job `publish_evidence` encadeado ao `publish_diagnosis` (ou ao `publish_forecast` se não houver diagnosis), entrada no `.railway/railway.ts` e no `docker-compose.yml`, e o `.env.example` atualizado (aproveitar para incluir as variáveis da voz que faltam).

## 7. Plano de execução (datas reais)

- **F0, 15/09 (feito):** decisão de repo aprovada pelo Vitor; Guilherme colaborador; 3 JSON Schemas + `gateway.yaml` em `docs/rag/`; PR #1 (`rag/f0-spec`).
- **F1, 16 a 18/09 (Claude Code, um PR por tarefa; roteiro em `docs/rag/f1-brief.md`):** T1.1 esqueleto `apps/rag` + compose + railway.ts + `.env.example`; T1.2 gateway com testes de 429/cota/fallback; T1.3 migrações `rag`; T1.4 crawler BDO (pastas diárias, 24 meses, 17 tabelas HTML + PDF) e Procedimentos (lista da página vigente); T1.5 Docling + chunker + metadados; T1.6 indexação bge-m3 via NIM com worker `arq` e `GET /internal/rag/jobs/{id}`. Entrega: BDO de 24 meses + submódulos indexados, relatório de cobertura.
- **F2, 18 a 20/09 (Claude Code; janela da AWS):** T2.1 híbrido + rerank + `POST /internal/rag/query`; T2.2 Evidence Builder + gates + NA-01 **[revisão]**; T2.3 `eval/run_eval.py` com `smoke.jsonl`; T2.4 crawler IPDO/RAP via Playwright (ou REST do SharePoint) com snapshot diário; T2.5 deploy na AWS de teste, medir cotas reais e ajustar `limits`.
- **F3, 21 a 24/09 (Claude Code + Vitor + Bisogno):** T3.1 rotas `/v1/evidence/*`, `/v1/rag/status`, `meta.rag`; T3.2 job `publish_evidence` encadeado; T3.3 `evidencia_documental` no alerta + regra do Bisogno lendo `supports/confidence`; T3.4 seção "Evidência" na tela Explicar (citações clicáveis, selos `found / insufficient / not_found / aguardando cota`), sem bloquear o card; T3.5 narração via gateway (D04) **[revisão]**; T3.6 `evidence.jsonl` com o Bisogno e avaliação.
- **F4, 25 a 27/09:** reingestão final, plano B offline (índice pronto + elo local + template), roteiro: um dia real com corte onde o RAG acha no BDO/IPDO a restrição e cita a tabela/página. Publicação no repo da organização só com "ok" do Guilherme.

## 8. Decisões pendentes (atualizadas)

- D-RAG-01 gateway dentro do `apps/rag`: **recomendado, seguir salvo objeção**.
- D-RAG-02 mesmo Postgres com schema `rag`: **recomendado** (o `apps/ml` é read-only; o `apps/rag` precisa de escrita, então role própria com `GRANT` só no schema `rag`).
- D-RAG-03 corpus: **definido** (seção 2), falta o Bisogno confirmar nomes exatos do Submódulo 22.3 / Módulo 10 na listagem e a página das perguntas.
- D-RAG-04 Postgres desde o início: **recomendado**.
- D-RAG-05 hospedagem: enquete aberta (2 votos: 1 AWS, 1 Railway); Bisogno recomenda AWS no presencial com Railway de reserva.
- D-RAG-06 elo pago: enquete aberta (2 votos: 1 não, 1 decidir depois); Bisogno recomenda sim com US$ 5/dia.
- D-RAG-07 peso da evidência: **definido** como campo de exibição (seção 2), não como entrada do classificador.
- **D-RAG-08** tamanho da instância AWS para o `apps/rag` (t3.medium não aguenta fallback local de embedding + Postgres): pedir maior ou usar executor local na LAN.
- **D-RAG-09** repositório: monorepo `vtorres/WattSteer` + espelho final no repo da organização (seção 0). Precisa do "ok" do Vitor (dono) e do Guilherme.
