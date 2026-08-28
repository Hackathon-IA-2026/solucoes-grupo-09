import type { Copy } from "./copy.en";

/**
 * Portuguese (pt-BR) — the default locale.
 *
 * Authored, not translated, where a literal rendering would be worse. The
 * hero is the clearest case: the English headline turns on a tense pun
 * ("happened" / "is coming") that does not survive word-for-word, and
 * IDEA.md §46 already contains a stronger Portuguese original. That sentence
 * is used here rather than a translation of the English one.
 *
 * Sector vocabulary stays in the form the sector actually uses. "Curtailment"
 * has no clean Portuguese equivalent and ONS's own term is "constrained-off",
 * so both appear untranslated — as they do in ONS's own documents.
 */
export const pt: Copy = {
  nav: {
    home: "WattSteer — início",
    links: [
      { label: "A previsão", target: "forecast" },
      { label: "Como funciona", target: "engines" },
      { label: "O produto", target: "showcase" },
      { label: "Dados", target: "provenance" },
    ],
    cta: "Ver a rede agora",
  },

  hero: {
    eyebrow: "Previsão de curtailment para o dia seguinte · rede brasileira",
    headline: {
      lead: "Hoje conseguimos saber que houve curtailment.",
      accent: "O WattSteer avisa antes.",
    },
    sub: "O Brasil está adicionando solar e eólica muito mais rápido do que consegue tornar a rede flexível. Em vários momentos temos energia limpa disponível e precisamos cortá-la. O WattSteer prevê essas horas com um dia de antecedência a partir dos dados abertos do ONS — como faixa, não como chute —, explica as condições da rede por trás delas e dimensiona o armazenamento e a demanda flexível capazes de absorvê-las.",
    primaryCta: "Ver a rede agora",
    secondaryCta: "Como a previsão é construída",
  },

  readout: {
    title: "Amanhã na rede brasileira",
    nationalLabel: "Energia prevista em constrained-off, os quatro subsistemas",
    nationalGrainNote:
      "O número nacional é a soma dos quatro subsistemas. O ONS publica uma linha SIN; o WattSteer nunca a usa, porque ela duplicaria a contagem em relação às linhas de subsistema ao lado.",
    sampleBadge: "Dados de exemplo",
    sampleNote:
      "Fixture ilustrativa. O dado ao vivo chega junto com o serviço de previsão; nada nesta página é uma previsão real ainda.",
    subsystemsTitle: "Por subsistema",
    columnProbability: "Chance de curtailment",
    profileTitle: "Hora a hora",
    profileSub: "Energia prevista em constrained-off por hora, nacional",
    profileCaption:
      "A faixa sombreada é P10–P90; a linha é a P50. Uma hora conta como cortada acima do limiar de 5 MW por subsistema, que é carimbado em todo número que o WattSteer publica.",
    additivityNote:
      "As faixas por subsistema não somam a faixa nacional, e as faixas horárias não somam a diária. Quantis não são aditivos — apenas as medianas P50 aparecem somando, e mesmo isso é uma convenção.",
    originLabel: "Origem da previsão",
  },

  band: {
    rangeLabel: "P10–P90",
    medianLabel: "P50",
    observedLabel: "Observado",
    observedNote: "Valor medido. Sem faixa, porque não há previsão.",
    explainerTitle: "Todo número aqui tem uma largura",
    explainerBody:
      "Uma previsão de curtailment que diz 4.180 MWh e mais nada é um número se passando por fato. O WattSteer publica P10, P50 e P90 juntos e desenha a distância entre eles, para que a largura da incerteza seja tão visível quanto o meio dela. Onde um número genuinamente não tem faixa — um valor histórico medido — ele é marcado como observado, para que a ausência signifique alguma coisa.",
  },

  engines: {
    title: "Quatro motores, não um modelo",
    sub: "Prever sozinho é metade do produto. O valor está no que acontece depois do número.",
    items: [
      {
        name: "Previsor",
        question: "Vai acontecer, quanto, onde, quando?",
        body: "Um modelo hurdle — classificador de ocorrência mais regressão de magnitude — sobre o balanço do ONS, carga, intercâmbio e meteorologia ponderada por capacidade instalada. Dia seguinte, as 24 horas, em P10/P50/P90.",
      },
      {
        name: "Diagnóstico",
        question: "A quais condições da rede o risco está associado?",
        body: "Atribuição SHAP sobre as features do próprio modelo, arbitrada por regras de domínio. Explica por que o modelo elevou sua previsão — deliberadamente não por que o evento ocorreu fisicamente.",
      },
      {
        name: "Otimizador de flexibilidade",
        question: "O que absorveria isso, e em que tamanho?",
        body: "Um MILP sobre estado de carga de bateria e carga deslocável que devolve o despacho hora a hora, a energia recuperável e a parcela do curtailment que se mostra evitável.",
      },
      {
        name: "Replay",
        question: "Quanto poderia ter sido recuperado?",
        body: "Reexecuta um dia histórico real com a informação disponível na véspera, depois revela o que de fato aconteceu e mede a diferença.",
      },
    ],
  },

  showcase: {
    badge: "Dados de exemplo · os componentes reais",
    title: {
      lead: "A previsão é onde tudo",
      accent: "começa.",
    },
    sub: "Estes são os próprios painéis do produto, renderizados sobre uma fixture determinística. Mesmos componentes, mesmas unidades, mesmas faixas das telas ao vivo.",
    explain: {
      panelTitle: "Diagnóstico",
      panelSub: "NORDESTE · amanhã",
      heading: "A quais condições o risco está associado",
      note: "Contribuição SHAP para a previsão do modelo, normalizada em 100%. São os drivers do modelo, não uma afirmação causal sobre a rede.",
    },
    mitigate: {
      panelTitle: "Otimizador de flexibilidade",
      panelSub: "NORDESTE · amanhã",
      heading: "Que flexibilidade absorveria isso",
      baselineLabel: "Sem ação",
      note: "Os parâmetros dos ativos são entradas de cenário, não um inventário — o ONS não publica registro de ativos de flexibilidade, então isto é um e-se, não um plano.",
      recoveredLabel: "Energia recuperada",
      avoidedLabel: "Curtailment evitado",
      scenarioLabel: "Cenário econômico",
    },
    replay: {
      panelTitle: "Replay",
      panelSub: "NORDESTE · um dia real",
      heading: "Quanto poderia ter sido recuperado",
      actualLabel: "Cortado de fato",
      optimizedLabel: "Com o WattSteer",
      recoveredLabel: "Recuperado",
      reductionLabel: "Redução de curtailment",
      vintageNote:
        "Esta janela é anterior à ingestão do WattSteer, então o passado mostrado aqui é a reafirmação atual do ONS sobre ele, não o que era conhecível no dia. Marcado como otimista quanto a revisões, e isso nunca poderá ser corrigido: o ONS reescreve o histórico no lugar.",
    },
  },

  provenance: {
    title: "Tudo aqui vem de dados públicos",
    sub: "Sem conta, sem login, nada atrás de um muro. O WattSteer lê dados publicados abertamente e mostra as contas.",
    sources: [
      {
        name: "ONS Dados Abertos",
        body: "Constrained-off de eólica e solar, o balanço de energia por subsistema, carga verificada, intercâmbio e DESSEM. O próprio rótulo de curtailment e todas as grandezas de rede por trás dele.",
      },
      {
        name: "ANEEL SIGA",
        body: "Coordenadas das usinas, município e propriedade, usados para situar o parque no mapa e ponderar a meteorologia pela capacidade instalada. Capacidade e datas de entrada em operação vêm do ONS, não daqui.",
      },
      {
        name: "Open-Meteo",
        body: "Vento e irradiância para o dia seguinte em centroides de cluster, a partir de uma rodada de modelo fixada, agregados por capacidade instalada variável no tempo.",
      },
    ],
    honesty: {
      title: "O que o WattSteer não vai afirmar",
      items: [
        {
          label: "Nenhum número de carbono",
          body: "Energia renovável que deixa de ser cortada não corresponde a uma economia fixa de CO₂ sem saber qual geração ela substituiu. O WattSteer reporta energia recuperada e não diz nada sobre carbono.",
        },
        {
          label: "R$ apenas como cenário rotulado",
          body: "Dinheiro aparece exatamente uma vez, ao lado do R$/MWh que foi assumido. Compensação e precificação de curtailment são questões regulatórias que este produto não responde.",
        },
        {
          label: "Razões apenas no grão em que o ONS as reporta",
          body: "A razão de uma restrição é propriedade de uma entidade de medição — um conjunto para a maior parte da eólica, uma usina só onde a usina reporta por si. O WattSteer nunca aloca uma razão até a usina e a apresenta como observação.",
        },
        {
          label: "A safra do dado fica na tela",
          body: "Toda previsão nomeia a rodada que a produziu, e todo backtest diz se sua janela era de fato conhecível na época ou é a reafirmação posterior do ONS.",
        },
      ],
    },
    odbl: "Os dados do registro de usinas derivam do ANEEL SIGA, © ANEEL, disponibilizados sob a Open Database License (ODbL) v1.0. A tabela de usinas derivada pelo WattSteer é um Banco de Dados Derivado e é oferecida sob a mesma licença.",
    disclaimer:
      "O WattSteer não é afiliado ao ONS nem à ANEEL. As previsões são estimativas modeladas, não instruções de operação, sinais de negociação ou recomendação.",
  },

  footerCta: {
    headline: {
      lead: "Não apenas preveja energia desperdiçada.",
      accent: "Evite-a.",
    },
    sub: "Risco de curtailment para o dia seguinte na rede brasileira, a partir de dados abertos.",
    button: "Ver a rede agora",
  },
};
