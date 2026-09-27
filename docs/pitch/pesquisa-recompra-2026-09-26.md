# Pesquisa para o pitch — 26/09/2026

Prazo: 20 min / 15 buscas. Resumo direto, com citação literal e URL sempre que possível.

---

## 1. Base dos "15% a menos" no release da Auren (4T25/2025)

**Resposta**: a base de 1.469 MW médios é a **"geração potencial"**, um conceito definido pela própria Auren em nota de rodapé do release — **não** é garantia física, e não é definida como "P50" (o P50 entra só como régua de comparação, não como definição).

Definição literal da empresa (nota de rodapé, seção "Destaques do Período"):

> "Geração potencial = geração de energia + parcela de energia não produzida devido aos diferentes tipos de restrição do ONS."

Trecho principal (corpo do release, análise anual da fonte eólica):

> "Vale destacar o desempenho operacional dos ativos eólicos no ano de 2025, cuja produção de energia atingiu 1.242 MW médios no ano, 9,0% superior ao ano de 2024 e equivalente a 92,9% do percentil 90 (P90) da curva de certificação de produção dos ativos. Ao analisar a geração potencial, expurgando-se o impacto do curtailment, a geração de 2025 totalizaria 1.469 MW médios ou 100,2% do percentil 50 (P50) e 109,7% do percentil 90 (P90), demonstrando a qualidade e resiliência dos ativos da Companhia."

E a nota de rodapé do próprio número de 1.242 MW médios (geração real), que também importa para não confundir os dois lados da conta:

> "Considera a geração efetiva somada a energia que será ressarcida, ou seja, o curtailment classificado como Razão de Indisponibilidade Externa (REL) após atingimento da franquia."

**Leitura correta, em português simples**: 1.242 MW médios é o que os parques eólicos realmente entregaram (já incluindo o ressarcimento de um tipo específico de corte, o REL acima da franquia). 1.469 MW médios é uma reconstrução: quanto esses mesmos parques teriam gerado se não houvesse **nenhum tipo de corte do ONS** (curtailment em geral, não só REL). A diferença entre os dois (~15,5%) é, portanto, energia perdida por corte de geração, não é uma comparação com "quanto o contrato exige" nem com a garantia física da usina. O P50/P90 aparecem apenas para dizer "esse potencial de 1.469 bate com o que os estudos de vento previam" (100,2% do P50, 109,7% do P90) — é uma checagem de qualidade do ativo, não a definição da base de 1.469.

**Fonte**: PDF do release "Release de Resultados 4T25" (Auren Energia), já baixado localmente em `/private/tmp/claude-501/-Users-guilherme-www-labs-hackathon/dada8f2a-68ab-4928-adaf-c00e8b9fc0f7/scratchpad/auren4t25.pdf` (82 páginas, metadados do PDF: criado em 03/03/2026, autor "Fernando Oliveira", Adobe Acrobat — consistente com a data de divulgação do 4T25/2025 citada no pedido). Trechos extraídos com `pdftotext -layout` (arquivo `auren.txt` no mesmo diretório), linhas 100-106 e 291-296.

Uma cópia pública do mesmo release está indexada em investidor10 — [Release de Resultados 4T25 — Auren (investidor10)](https://investidor10.com.br/acoes/link_comunicado/aure3/32790/) — mas não consegui extrair o texto dela via fetch automático para confirmar byte a byte; uso-a só como referência de que o documento é público e localizável, não como fonte primária da citação (a citação acima vem do PDF local). Não encontrei o link direto no site oficial `ri.aurenenergia.com.br` dentro do orçamento de buscas (a página "Central de Resultados" não expõe o link do PDF no fetch automatizado).

**Grau de confiança**: alto para o conteúdo citado (é o texto literal do PDF do release, com nota de rodapé explícita da própria empresa). Médio para a URL pública exata do release no site da Auren (não confirmada; só o local + o mirror do investidor10).

---

## 2. Como o gerador cortado cobre o contrato

### (a) A exposição é liquidada no mercado de curto prazo pela CCEE, com PLD horário, na contabilização mensal?

**Sim, confirmado.** A liquidação de diferenças (Recursos vs. Requisitos) é feita pela CCEE por **PLD de cada hora**, dentro do **mês de contabilização**:

> "As diferenças no balanço entre os 'Recursos' e os 'Requisitos' será liquidada ao valor do PLD de cada hora do mês de contabilização."
> — [Regras de Comercialização CCEE: um guia das principais regras (Replace Consultoria)](https://replaceconsultoria.com.br/blog/guia-de-regras-de-comercializacao-ccee/)

O ciclo da CCEE roda cerca de 30 dias depois do mês de operação (ex.: operação de julho é contabilizada e os resultados saem em torno de 27 de agosto) — [Contabilização (CCEE)](https://www.ccee.org.br/contabilizacao). Ou seja: quando o gerador é cortado, essa energia não entregue vira exposição negativa, valorada ao PLD horário daquele momento específico, e o efeito financeiro só aparece na contabilização ~1 mês depois — não é instantâneo nem antecipável com precisão contratual.

**Confiança**: alta (regra documentada pela própria CCEE e reproduzida em guia de comercialização).

### (b) O gerador pode comprar energia antecipadamente para cobrir o déficit — com que antecedência isso é feito na prática?

**Parcialmente confirmado, e não do jeito que a frase do slide sugere.** O que encontrei nas fontes é o oposto do que a frase atual do slide sugere:

> "Quando há contratos firmados no mercado livre de contratação, o problema duplica: além de perder a receita da energia não despachada, o gerador precisa comprar energia no mercado de curto prazo, muitas vezes em momentos de alta volatilidade do mercado spot de energia para honrar as entregas contratadas."
> — [O gerador centralizado e o fantasma do curtailment (Debate Jurídico)](https://debatejuridico.com.br/o-gerador-centralizado-e-o-fantasma-do-curtailment/)

Isso descreve o gerador comprando **no mercado de curto prazo (spot)**, isto é, exposto ao PLD do momento do corte — não uma recompra antecipada, dias ou semanas antes, feita porque "sabe que vai parar". Não achei nenhuma fonte (CCEE, ANEEL, cartilha, artigo jurídico) descrevendo um mecanismo operacional de "comprar no balcão com X dias/semanas de antecedência especificamente para cobrir um corte já previsto" — o corte (constrained-off) é determinado pelo ONS em despacho de curtíssimo prazo (D-1/tempo real), o que dificulta esse tipo de antecipação tática.

O que existe, de fato, é uma prática de **hedge estrutural** (decidida no momento de fechar os contratos, não no momento do corte): não vender 100% da garantia física, manter margem descontratada, diversificar fontes/regiões:

> "Algumas empresas preferem contratar antecipadamente a maior parte da energia. Outras mantêm uma parcela disponível para aproveitar oportunidades no curto prazo."
> — [Por que consumidores e geradores precisam acompanhar o mesmo PLD de maneiras diferentes (Simple Energy)](https://simpleenergy.com.br/por-que-consumidores-e-geradores-precisam-acompanhar-o-mesmo-pld-de-maneiras-diferentes/)

O próprio release da Auren confirma esse padrão: a empresa mitiga o curtailment não com "recompra antecipada tática", mas com **ganhos de modulação** do portfólio diversificado (usar o perfil horário de outras fontes/usinas para compensar):

> "no 4T25, a Companhia obteve ganhos de modulação de R$ 70,4 milhões (...) mitigando parte importante do efeito do curtailment. Já descontados os ganhos com modulação, o impacto líquido do curtailment no trimestre totalizou R$ 137,0 milhões."
> — release 4T25/2025 (arquivo local `auren.txt`, linha ~118)

**Confiança**: média para "não há recompra tática antecipada específica por corte" (ausência de evidência dentro do tempo de busca, não uma prova definitiva de que a prática não exista em algum grau em mesas de trading); alta para "o hedge real é estrutural (subcontratação + diversificação/modulação), não uma recompra de véspera".

### (c) O preço de comprar antes costuma ser melhor que se expor ao PLD?

**Provavelmente sim em tese, mas não é isso que acontece na prática descrita pelas fontes.** A fonte jurídica citada em (b) diz que a compra para cobrir o corte acontece "muitas vezes em momentos de alta volatilidade do mercado spot" — ou seja, o gerador cortado tende a comprar justamente quando o PLD está mais caro (o corte concentra-se em períodos de sobra de geração renovável e problemas de rede, que hoje coincidem com PLD inflado em vários casos). Não encontrei nenhuma fonte quantificando "comprar antes custa X% menos que se expor ao PLD" para o caso específico de curtailment — a comparação de custo entre hedge estrutural e exposição ao PLD é discutida de forma genérica, sem número comparável ao contexto do pitch.

**Confiança**: baixa/indireta — inferência a partir de descrição qualitativa, sem dado quantitativo comparável.

### Avaliação da frase atual do slide

> "Pronto: cobre a energia já vendida antes que fique cara — sabe que vai parar; garante o contrato"

**Está incorreta na mecânica.** Ela sugere que o gerador antecipa o corte e recompra a energia *antes* do preço subir — como se houvesse previsibilidade e uma janela de recompra proativa. O que as fontes mostram é o inverso: o corte é decidido pelo ONS em cima da hora, a cobertura contratual acontece via **exposição ao PLD horário no mercado de curto prazo**, liquidada pela CCEE **~1 mês depois**, muitas vezes justamente nos momentos de PLD mais alto — não uma recompra antecipada e barata. A "garantia do contrato" existe (o gerador cumpre a venda financeiramente), mas o preço dessa garantia é dado pelo PLD do momento do corte, não escolhido pelo gerador.

### Frase sugerida para o slide (linguagem simples)

> "Quando é cortada, a usina ainda cumpre o contrato de venda — mas paga a diferença ao preço do mercado de curto prazo daquela hora (PLD), acertado pela CCEE cerca de um mês depois. Esse preço nem sempre é baixo: muitas vezes é justamente quando ele está mais alto."

Fonte de apoio para essa frase: CCEE (liquidação por PLD horário, contabilização mensal) + Debate Jurídico (compra no spot "em momentos de alta volatilidade").

---

## Limitações desta pesquisa

- Não confirmei o link direto do release no site oficial `ri.aurenenergia.com.br` (usei o PDF local + um mirror indexado no investidor10).
- Não encontrei fonte primária (CCEE/ANEEL) descrevendo explicitamente um mecanismo de "recompra bilateral com X dias/semanas de antecedência específica para cobrir curtailment previsto" — a ausência pode refletir limite da busca (20 min / poucas buscas), não uma prova de que a prática nunca ocorra em mesas de trading mais sofisticadas.
- Buscas usadas: 6 WebSearch + 6 WebFetch (dentro do limite de 15).
