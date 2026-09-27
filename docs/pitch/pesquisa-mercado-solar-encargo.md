# Pesquisa de mercado — usinas solares (UFV) e encargo do curtailment

Pesquisa feita em 26/09/2026, via WebSearch/WebFetch e curl+pdftotext (sem Chrome). Compacta, com o que foi achado e o que não foi.

---

## 1. Usinas solares centralizadas (UFV) em operação no Brasil

### Número mais recente com fonte primária citável

> "18,6 mil usinas solares fotovoltaicas em operação" — "potência instalada de geração solar centralizada, de 17,95 GW"

- **Número de usinas:** ~18.600 (18,6 mil)
- **Potência total:** 17,95 GW
- **Data do dado:** ANEEL, atualizado em 19/08/2025 (matéria publicada em 22/08/2025)
- **Fonte:** Revista Fotovolt (Arandanet), citando dados da ANEEL
- **URL:** https://www.arandanet.com.br/revista/fotovolt/noticia/11429-Energia-solar-atinge-60-GW-de-potencia-instalada-no-Brasil
- **Confiança:** B (secundária, mas cita ANEEL/SIGA como fonte primária nomeada e datada; não confirmei direto no portal SIGA porque as páginas de dados da ANEEL retornaram "conteúdo restrito" ao WebFetch)
- **Fato ou estimativa:** fato (contagem declarada, não projeção)

### Dado mais recente de potência (sem contagem de usinas)

> "O Brasil acaba de ultrapassar a marca de 20 GW (gigawatts) de potência instalada em usinas solares de grande porte"

- **Potência:** > 20 GW em usinas solares centralizadas (grande porte)
- **Data:** 12/01/2026
- **Fonte:** ABSOLAR (Associação Brasileira de Energia Solar Fotovoltaica)
- **URL:** https://www.absolar.org.br/noticia/grandes-usinas-solares-ultrapassam-20-gw-de-potencia-instalada-diz-absolar/
- **Confiança:** A (fonte primária, associação do setor com dados oficiais ANEEL)
- **Fato ou estimativa:** fato
- **Observação:** esta matéria da ABSOLAR **não traz o número de usinas**, só a potência. Confirma o texto do pedido: "se só houver potência, diga isso" — aqui é o caso.

### Nordeste

- ABSOLAR (12/01/2026): "as usinas fotovoltaicas centralizadas já operam em todos os estados, com forte concentração no Nordeste (**52% da potência**)". Não há contagem de usinas por região nessa fonte.
  - Mesma URL acima. Confiança A para o percentual de potência; **não encontrado** o número de usinas especificamente no Nordeste.
- Dado complementar (expansão, não estoque total): em 2025, até novembro, os 9 estados do Nordeste responderam por 2.685,76 MW (36,3% da expansão nacional do ano), com destaque à concentração de novos projetos em Bahia, Pernambuco e Piauí. Fonte: pv magazine Brasil, dez/2025 — https://www.pv-magazine-brasil.com/2025/12/04/solar-lidera-expansao-da-geracao-no-brasil-em-usinas-centralizadas-e-distribuidas/ — Confiança B (secundária, citando dados ANEEL/RALIE). Fato.

### Resumo para o slide

- Use **"~18,6 mil usinas solares centralizadas em operação, 17,95 GW (ANEEL, ago/2025)"** como o número com contagem de plantas — é o único achado com "número de usinas" + data + fonte nomeada.
- Se quiser o dado de potência mais recente (mais atualizado, sem contagem): **"mais de 20 GW em usinas solares de grande porte (ABSOLAR, jan/2026), 52% no Nordeste"**.
- **Não encontrado**: contagem oficial de quantas usinas (unidades) estão no Nordeste especificamente — só o percentual de potência.

---

## 2. Custo do ressarcimento do curtailment ao consumidor (Lei 15.269/2025, via ESS)

### (a) Valor total homologado ou estimado a ser lançado no ESS

**Não encontrado** um valor oficial homologado por ANEEL/CCEE/MME para o total a ser lançado no ESS pela versão da lei efetivamente sancionada (após os vetos).

O que existe, oficialmente, é a Nota Técnica nº 10/2025/DPME/SNEE do MME (que abriu a Consulta Pública 210/2025 sobre o Termo de Compromisso da Lei 15.269/2025):

> "O Poder Executivo argumentou que transferir ao consumidor, via ESS, o custo da energia não gerada por excesso de oferta [...] com um impacto potencial estimado de **bilhões de reais**, criaria um incentivo perverso..."

- Isso é uma referência **vaga e qualitativa** ("bilhões de reais"), aplicada à versão **mais ampla que foi vetada** (o art. 1º-A, que cobriria também cortes por sobreoferta) — não ao escopo final e mais restrito da lei sancionada (só indisponibilidade externa e confiabilidade elétrica).
- **Fonte:** Ministério de Minas e Energia, Nota Técnica nº 10/2025/DPME/SNEE, Processo nº 48370.000267/2025-81, assinada 30/12/2025.
- **URL do PDF:** https://agenciainfra.com/blog/wp-content/uploads/2025/12/Nota-tecnica-Consulta-Publica-210-MME.pdf
- **Confiança:** A (documento oficial do MME) para o texto citado; a cifra em si não é um número fechado, é qualitativa.
- **Fato ou estimativa:** o documento é fato (nota técnica real), mas o número que ele menciona é uma referência genérica, não uma estimativa quantificada.

Estimativas de mercado, não oficiais, sobre o valor da versão ampla (vetada):
- Setor privado (associações do setor): até **R$ 7 bilhões** — citado por eixos.com.br, https://eixos.com.br/energia-eletrica/compensacao-por-curtailment-na-lei-15-269-2025-desafios-para-a-regulamentacao/ — Confiança C (imprensa especializada, sem paper oficial linkado). Estimativa.
- MME, segundo relatório da XP Investimentos: **R$ 2 a 3 bilhões** — https://conteudos.xpi.com.br/acoes/relatorios/aneel-deve-suspender-cobrancas-por-curtailment-enquanto-novo-ressarcimento-e-regulado-veja-o-radar-energia-xp-janeiro/ — Confiança C (relatório de banco/corretora citando o MME de segunda mão, não a fonte primária). Estimativa.
- ABEEólica: cerca de **R$ 4 bilhões** — mesma reportagem-síntese acima, sem link direto a nota da ABEEólica. Confiança C. Estimativa.
- **Importante:** essas três cifras (2-3bi, 4bi, 7bi) parecem se referir à versão ampla do texto, que foi parcialmente vetada. Não há confirmação de qual delas corresponde ao escopo final sancionado (só indisponibilidade externa + confiabilidade elétrica, retroativo a set/2023–nov/2025). Trate como estimativas de mercado, não como o custo real da lei em vigor.

### (b) Estimativa oficial de impacto em R$/MWh ou % na tarifa

**Não encontrado.** Nenhuma fonte oficial (ANEEL, CCEE, MME) com R$/MWh ou % de impacto tarifário localizada nas buscas realizadas. A Nota Técnica do MME menciona apenas "modicidade tarifária" e "impacto potencial estimado de bilhões de reais" sem dividir por MWh ou tarifa.

### Consumo anual do SIN (para permitir a conta própria)

> "O consumo total de energia elétrica no Brasil foi de **561,6 TWh**, cerca de 5,6% maior do que no ano anterior [2023]."

- **Ano-base:** 2024
- **Fonte:** EPE — Anuário Estatístico de Energia Elétrica 2025 (fonte primária dos dados de consumo: SIMPLES/EPE, 2025)
- **URL:** https://www.epe.gov.br/sites-pt/publicacoes-dados-abertos/publicacoes/PublicacoesArquivos/publicacao-160/topico-168/anuario-factsheet.pdf (extraído via curl + `pdftotext -layout`, página 4 de 6 do factsheet)
- **Confiança:** A (fonte oficial primária, documento baixado e lido diretamente)
- **Fato ou estimativa:** fato

Há também uma cifra de 2025 (não oficial/fechada ainda, pois o ano não terminou): 566,7 TWh, citada por fonte secundária sem link direto verificado nesta pesquisa — **descartada** do slide por falta de confirmação primária; use os 561,6 TWh de 2024 (EPE), que é o dado fechado e oficial mais recente.

### Conta própria (marcada como tal — NÃO é dado oficial)

Se quiser ilustrar o impacto por MWh usando as estimativas de mercado (não oficiais) sobre o consumo oficial do SIN:

- R$ 2 bi (estimativa MME/mercado, versão ampla) ÷ 561,6 TWh (EPE, 2024) ≈ **R$ 3,6/MWh**
- R$ 7 bi (estimativa setor privado, versão ampla) ÷ 561,6 TWh (EPE, 2024) ≈ **R$ 12,5/MWh**

Isto é uma divisão simples feita aqui, não um número publicado por nenhum órgão — e mistura uma estimativa da versão *vetada* (mais ampla) com o consumo real de 2024. Rotule no slide como "conta ilustrativa própria, não oficial" se usar.

---

## Honestidade sobre os limites desta pesquisa

- Não consegui acessar diretamente o portal SIGA da ANEEL (gov.br/aneel) nem a API de dados abertos com o dataset certo dentro do tempo/buscas disponíveis — os números de usinas vêm de imprensa especializada (Fotovolt/Arandanet) que cita a ANEEL como fonte, não do SIGA em primeira mão.
- Não encontrei nenhum valor R$ homologado especificamente para o escopo final (pós-veto) do ESS da Lei 15.269/2025 — só referências qualitativas (MME) e estimativas de mercado sobre a versão mais ampla que foi vetada.
- Não encontrei R$/MWh ou % de tarifa oficial.
- Buscas usadas: 11 WebSearch + 5 WebFetch/curl (dentro do limite de 12 buscas, tempo aproximado ~15 min).
