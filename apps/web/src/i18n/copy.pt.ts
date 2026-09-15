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
  },

  splash: {
    tagline: "Inteligência de curtailment para a rede elétrica brasileira.",
    loading: "Carregando o WattSteer",
    continue: "Continuar para o WattSteer",
  },

  footer: {
    rights: "© WattSteer {year}. Todos os direitos reservados.",
  },

  notFound: {
    metaTitle: "Página não encontrada — WattSteer",
    title: "Página não encontrada",
    body: "A página que você procura não existe.",
    back: "Voltar para o WattSteer",
  },

  error: {
    // Os erros do próprio gateway
    BAD_INPUT: "Havia algo errado nessa requisição.",
    REQUEST_INVALID: "Essa requisição não corresponde ao que este endpoint aceita.",
    ROUTE_NOT_FOUND: "Esse endereço não existe nesta API.",
    INTERNAL: "Algo deu errado do nosso lado. O erro foi registrado.",
    UPSTREAM_UNAVAILABLE: "Uma fonte de dados da qual dependemos não respondeu.",
    SERVICE_BUSY: "O WattSteer está no limite de capacidade. Tente de novo em instantes.",
    PAYLOAD_TOO_LARGE: "Essa requisição é maior do que este endpoint aceita.",

    // Os quatro estados de "sem previsão", e a falha de publicação ao lado deles
    FORECAST_NOT_YET_PUBLISHED:
      "A previsão desse dia ainda não foi publicada — o horário de corte ainda não passou.",
    FORECAST_UNAVAILABLE:
      "O horário de corte passou e nenhuma previsão foi gravada para esse dia. Isso é uma falha de publicação nossa, não um resultado vazio.",
    MODEL_UNAVAILABLE:
      "Nenhum modelo está promovido para atendimento, então nenhuma previsão é oferecida. Os painéis do que foi observado seguem valendo.",
    DATA_UNAVAILABLE:
      "Não conseguimos alcançar nosso banco de dados. Tente de novo em instantes.",
    DIAGNOSIS_UNAVAILABLE:
      "Esse dia tem previsão, mas nenhuma explicação foi calculada para ele.",

    // O que esta superfície recusa
    SUBSYSTEM_UNKNOWN: "Esse não é um dos quatro subsistemas.",
    TARGET_DATE_OUT_OF_RANGE:
      "Essa data está fora da janela que o WattSteer cobre — nada antes do início dos dados, e nada depois de amanhã.",
    DATE_RANGE_TOO_LARGE:
      "Esse intervalo de datas é maior do que uma única requisição pode pedir.",
    GATE_PROFILE_UNKNOWN: "Esse não é um dos horários de publicação.",
    LOCALE_UNSUPPORTED: "O WattSteer responde apenas em português e inglês.",
    RATE_LIMITED: "Requisições demais. Espere um momento e tente de novo.",

    // O serviço de modelagem
    OPTIMIZER_NOT_CONFIGURED:
      "O otimizador não está configurado nesta instalação, então cenários não podem ser resolvidos aqui.",
    OPTIMIZER_UNAVAILABLE: "Não foi possível alcançar o otimizador.",
    OPTIMIZER_TIMEOUT: "O otimizador não respondeu a tempo.",
    OPTIMIZER_NOT_READY: "O otimizador está subindo e ainda não consegue resolver.",
    UPSTREAM_REJECTED: "O otimizador recusou essa requisição.",
    UPSTREAM_FAILED: "O otimizador falhou nessa requisição.",

    // A resolução
    SOLVER_GAP_UNCLOSED:
      "O solver esgotou o tempo antes de provar que a resposta era ótima, então nenhum despacho é oferecido.",
    SOLVER_TIMEOUT: "O solver desistiu de esperar por esse cenário.",
    SOLVER_BUG: "Esse cenário quebrou o solver. O erro foi registrado.",

    // A tabela de validação do cenário
    SCENARIO_VERSION_UNSUPPORTED: "Esse cenário foi escrito para outra versão.",
    SCENARIO_TOO_LARGE: "Esse cenário é maior do que o limite publicado.",
    ASSET_TYPE_UNKNOWN: "Esse não é um tipo de ativo que o otimizador conhece.",
    SUBSYSTEM_MISMATCH:
      "Todos os ativos de um cenário precisam estar no mesmo subsistema.",
    FIELD_NOT_ON_VARIANT: "Esse campo não pertence a este tipo de ativo.",
    MAGNITUDE_OUT_OF_RANGE: "Esse valor está fora da faixa que o otimizador aceita.",
    RTE_OUT_OF_RANGE: "Uma eficiência de ciclo completo precisa ficar entre 0 e 1.",
    EFFICIENCY_PAIR_INCOMPLETE:
      "As eficiências de carga e descarga são informadas juntas ou nenhuma das duas.",
    SOC_BOUNDS_INVALID: "O estado de carga mínimo precisa ficar abaixo do máximo.",
    SOC_INITIAL_OUT_OF_BOUNDS:
      "O estado de carga inicial está fora dos próprios limites.",
    POWER_LIMIT_INCONSISTENT: "Esses limites de potência se contradizem.",
    SHIFT_EXCEEDS_CONNECTION:
      "Esse deslocamento é maior do que a conexão consegue transportar.",
    SHIFT_EXCEEDS_BASELINE: "Esse deslocamento é maior do que a carga que ele moveria.",
    SHIFT_WINDOW_OUT_OF_RANGE: "Essa janela de deslocamento não cabe dentro de um dia.",
    RECOVERY_TIME_OUT_OF_RANGE: "Esse tempo de recuperação está fora da faixa aceita.",
    AVAILABILITY_INVALID:
      "A disponibilidade precisa ser informada para cada hora, entre 0 e 1.",
    ECONOMIC_ASSUMPTION_OUT_OF_RANGE:
      "Essa premissa econômica está fora da faixa que o otimizador aceita.",

    // As cinco recusas do Replay
    REPLAY_DATE_BEFORE_HOLDOUT_WINDOW:
      "Esse dia estava dentro da janela de treino do modelo, então repeti-lo inflaria o resultado. Só o que foi observado é mostrado para ele.",
    REPLAY_DATE_OUT_OF_RANGE:
      "Esse dia não pode ser repetido — ele ainda não está fechado.",
    REPLAY_FORECAST_UNAVAILABLE:
      "Não existe previsão fora da amostra guardada para esse dia.",
    REPLAY_OBSERVATION_INCOMPLETE:
      "O ONS ainda não fechou todas as horas desse dia, então ele não pode ser avaliado.",
    REPLAY_INTEGRITY_VIOLATION:
      "Não conseguimos provar que esse dia ficou fora do treino, então nada é mostrado para ele. O caso foi registrado.",
  },

  noForecast: {
    notYetPublished:
      "A visão de amanhã é publicada às {gate}. O que está abaixo é a previsão de hoje.",
    noPromotedArtifact:
      "Nenhum modelo está promovido para atendimento, então nada é previsto. O que foi observado segue valendo, e a Máquina do Tempo continua funcionando.",
    stale: "Publicada {age} — antes do horário de corte mais recente.",
    unavailable:
      "O serviço de previsão está inacessível no momento. Tente de novo em instantes.",
  },

  hero: {
    eyebrow: "Previsão de curtailment para o dia seguinte · rede brasileira",
    headline: {
      lead: "Hoje conseguimos saber que houve curtailment.",
      accent: "O WattSteer avisa antes.",
    },
    sub: "O Brasil está adicionando solar e eólica muito mais rápido do que consegue tornar a rede flexível. Em vários momentos temos energia limpa disponível e precisamos cortá-la. O WattSteer prevê essas horas com um dia de antecedência a partir dos dados abertos do ONS — como faixa, não como chute —, explica as condições da rede por trás delas e dimensiona o armazenamento e a demanda flexível capazes de absorvê-las.",
    primaryCta: "Abrir o protótipo",
    secondaryCta: "Como a previsão é construída",
  },

  readout: {
    title: "Amanhã na rede brasileira",
    nationalLabel: "Energia esperada em constrained-off, os quatro subsistemas",
    nationalGrainNote:
      "O número nacional é a soma da energia esperada dos quatro subsistemas, e essa soma é exata — valores esperados somam qualquer que seja a dependência entre os subsistemas. O ONS publica uma linha SIN; o WattSteer nunca a usa, porque ela duplicaria a contagem em relação às linhas de subsistema ao lado.",
    riskCounts: "Subsistemas por risco: alto {high} · elevado {elevated} · baixo {low}",
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
      "Nada nesta coluna soma o número ao lado. Faixas não são aditivas, e medianas também não: a P50 de uma soma só é a soma das P50 se os quatro subsistemas se moverem juntos, e eles não se movem. O valor esperado é a única grandeza que soma exatamente — por isso o número nacional é um.",
    originLabel: "Origem da previsão",
    originValue:
      "{producer} · {run} · publicada em {published} · rodada meteorológica {weatherRun}",
  },

  band: {
    rangeLabel: "P10–P90",
    medianLabel: "P50",
    observedLabel: "Observado",
    observedNote: "Valor medido. Sem faixa, porque não há previsão.",
    expectedLabel: "Valor esperado",
    figureExpected:
      "{label}: valor esperado de {value} {unit}, publicado sem faixa de previsão",
    noBand: {
      no_joint_ensemble:
        "Sem faixa: a previsão sorteia seu ensemble de 500 trajetórias um subsistema por vez, então não existe distribuição conjunta de onde ler uma P10–P90 nacional. Somar os quantis dos quatro subsistemas inventaria uma. O valor esperado não precisa dessa suposição.",
    },
    explainerTitle: "Todo número aqui tem uma largura",
    explainerConfident: "Uma previsão confiante",
    explainerUncertain: "Uma bem aberta",
    explainerSame:
      "Mesma mediana — {value} MWh — e um card de número único imprimiria as duas igualzinhas.",
    railObserved: "{label}: {value} {unit}, observado",
    railBand: "{label}: mediana {p50} {unit}, percentil 10 a 90 de {p10} a {p90} {unit}",
    hourFigure: "{hour} — mediana {p50} {unit}, P10 a P90 de {p10} a {p90} {unit}",
    explainerBody:
      "Uma previsão de curtailment que diz 4.180 MWh e mais nada é um número se passando por fato. O WattSteer publica P10, P50 e P90 juntos e desenha a distância entre eles, para que a largura da incerteza seja tão visível quanto o meio dela. Onde um número genuinamente não tem faixa — um valor histórico medido — ele é marcado como observado, para que a ausência signifique alguma coisa.",
  },

  engines: {
    title: "Quatro motores, não um modelo",
    sub: "Prever sozinho é metade do produto. O valor está no que acontece depois do número.",
    status:
      "Onde cada um está hoje: a ingestão e a plataforma de dados estão no ar, lendo ONS, ANEEL e Open-Meteo no horário. Nenhum artefato de modelo está promovido para atendimento ainda, então as rotas de Previsor e Diagnóstico respondem com uma recusa declarada em vez de uma previsão, e todo número mostrado nesta página é uma fixture determinística. O Otimizador de flexibilidade e o Replay resolvem contra um gateway real quando há um rodando.",
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
    sub: "Estes são os próprios painéis do produto, renderizados sobre uma fixture determinística. Mesmos componentes, mesmas unidades, mesmas faixas das telas do próprio protótipo.",
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
      stepBattery: "+ Bateria",
      stepLoad: "+ Carga flexível",
      detailBattery: "{power} MW / {energy} MWh, ciclo completo {efficiency}",
      detailLoad: "{shift} MW deslocáveis, janela de {window} h",
      recoveredLabel: "Energia recuperada",
      avoidedLabel: "Curtailment evitado",
      medianToMedian: "de mediana para mediana",
      scenarioLabel: "Cenário econômico",
      economicNote: "{value} a um valor assumido de {rate}/MWh",
    },
    replay: {
      panelTitle: "Replay",
      heading: "Quanto poderia ter sido recuperado",
      actualLabel: "Cortado de fato",
      optimizedLabel: "Com o WattSteer",
      recoveredLabel: "Recuperado",
      reductionLabel: "Redução de curtailment",
      vintageBadge: "otimista por revisão",
      medianToObserved: "de mediana para observado",
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
        {
          label: "Nenhuma manutenção de transmissão é lida",
          body: "O ONS publica manutenções programadas e indisponibilidades como texto corrido, não como conjunto de dados, e o WattSteer não ingere nada disso. Então um dia cujo curtailment veio de uma linha fora de serviço não tem nenhuma variável carregando esse fato, e o modelo lê ao redor dele. Nada neste site deriva de dados de manutenção.",
        },
      ],
    },
  },

  footerCta: {
    headline: {
      lead: "Não apenas preveja energia desperdiçada.",
      accent: "Evite-a.",
    },
    sub: "Risco de curtailment para o dia seguinte na rede brasileira, a partir de dados abertos.",
    button: "Abrir o protótipo",
  },

  meta: {
    home: {
      title: "WattSteer — inteligência de curtailment renovável para a rede brasileira",
      description:
        "Risco de curtailment para o dia seguinte nos quatro subsistemas brasileiros, previsto como faixa P10–P90 a partir de dados abertos do ONS — com as condições de rede por trás dele e o armazenamento e a demanda flexível capazes de absorvê-lo.",
    },
    privacy: {
      title: "Política de Privacidade — WattSteer",
      description:
        "O WattSteer não tem contas nem dados pessoais. Esta política descreve o pouco que tratamos.",
    },
    terms: {
      title: "Termos de Uso — WattSteer",
      description:
        "O WattSteer é uma análise pública e somente leitura de dados abertos da rede brasileira. Estes termos regem o seu uso.",
    },
  },

  pitch: {
    metaTitle: "Apresentação — WattSteer",
    metaDescription:
      "A apresentação do WattSteer: quanto o curtailment custa à rede brasileira e o que vale enxergá-lo com um dia de antecedência.",
    badge: "Apresentação",
    title: "O argumento do WattSteer, em dez slides",
    lede: "O mesmo argumento que o produto faz, na ordem em que ele foi feito pela primeira vez: a energia cortada que o ONS já publica, a previsão que a teria antecipado e o que uma usina faria com um dia de aviso.",
    embedTitle: "Apresentação do WattSteer (PDF)",
    fallback:
      "A apresentação é um PDF. Se o seu navegador baixa PDFs em vez de exibi-los, o quadro abaixo fica vazio.",
    openLabel: "Abrir o PDF",
    /** The footer link. Short: it sits in a row with the legal links. */
    footerLink: "Apresentação",
  },

  legal: {
    homeLink: "WattSteer — início",
    privacyLink: "Privacidade",
    termsLink: "Termos",

    privacy: {
      badge: "Política de Privacidade",
      updated: "Última atualização: 28 de agosto de 2026",
      title: "Política de Privacidade",
      intro:
        "O WattSteer não tem contas nem dados pessoais. Esta política descreve o pouco que tratamos.",
      summary: {
        title: "A versão curta",
        body: "O WattSteer não tem contas de usuário, não tem login e não tem dados pessoais a coletar. Ele analisa dados do sistema elétrico publicados abertamente — nenhum deles descreve pessoas.",
        cardTitle: "O que isso significa",
        cardItems: [
          "Sem cadastro, sem conta, sem perfil",
          "Sem cookies de publicidade ou rastreamento entre sites",
          "Nenhuma venda ou compartilhamento de dados sobre você",
          "Nada do que você digita é guardado atrelado a uma identidade",
        ],
      },
      processing: {
        title: "O que passa pelo WattSteer",
        body: "Os dados com que o WattSteer trabalha são publicados abertamente por órgãos do setor elétrico e reguladores e descrevem usinas, carga, geração e clima — não pessoas.",
        scenarios:
          "Se você explorar um cenário hipotético, os parâmetros que digitar servem apenas para calcular o resultado que você pediu. Eles não são associados a nenhuma identidade.",
      },
      logs: {
        title: "Registros de servidor",
        body: "Como qualquer serviço web, nossa infraestrutura registra logs comuns de requisição — endereço IP, horário, caminho, user agent — para segurança, prevenção de abuso e depuração. Eles são retidos por pouco tempo e não são usados para montar um perfil seu.",
      },
      cookies: {
        title: "Cookies e armazenamento",
        body: "O WattSteer não usa cookies de publicidade nem de rastreamento entre sites. Qualquer armazenamento no navegador se limita a lembrar suas próprias preferências de exibição — o idioma escolhido, por exemplo — no seu próprio dispositivo, e nunca chega aos nossos servidores.",
      },
      contact: {
        title: "Contato",
        body: "Dúvidas sobre esta política podem ser enviadas ao endereço publicado no nosso repositório.",
      },
    },

    terms: {
      badge: "Termos de Uso",
      updated: "Última atualização: 28 de agosto de 2026",
      title: "Termos de Uso",
      intro:
        "O WattSteer é uma análise pública e somente leitura de dados abertos da rede elétrica. Estes termos regem o seu uso.",
      overview: {
        title: "Visão geral",
        body: "Estes Termos de Uso regem a utilização do WattSteer, um site público e somente leitura que analisa dados abertos do sistema elétrico brasileiro para estimar o curtailment de renováveis e a flexibilidade capaz de absorvê-lo. Ao usar o WattSteer você concorda com estes Termos.",
        cardTitle: "Princípios",
        cardItems: [
          "Uso gratuito — sem conta e sem cadastro",
          "Trabalhamos apenas com dados abertos publicados publicamente",
          "Previsões e cenários são estimativas, não instruções de operação",
          "Transparência sobre o que o serviço faz e o que não faz",
        ],
      },
      service: {
        title: "O serviço",
        body: "O WattSteer publica estimativas de curtailment de renováveis por subsistema para o dia seguinte, uma explicação das condições de rede associadas a essa estimativa e cenários hipotéticos mostrando quanto do curtailment estimado uma dada quantidade de armazenamento ou demanda flexível conseguiria absorver.",
        sources:
          "Os dados de origem são publicados pelo ONS (Operador Nacional do Sistema Elétrico), pela ANEEL e por provedores de dados meteorológicos. O WattSteer não é afiliado a nenhum deles, não é endossado por eles nem opera em seu nome.",
      },
      reliance: {
        title: "Nada aqui serve para operar a rede",
        body: "Tudo que o WattSteer publica é uma estimativa modelada, carrega incerteza e pode estar errado. Não é instrução de operação da rede, não é sinal de negociação e não é recomendação de investimento, engenharia ou regulação.",
        yours:
          "Não use o WattSteer como insumo de operação em tempo real, despacho ou liquidação. Decisões com consequências físicas ou financeiras continuam sendo suas e devem se apoiar nas fontes oficiais.",
      },
      availability: {
        title: "Disponibilidade e mudanças",
        body: "O serviço é oferecido no estado em que se encontra, sem garantia de disponibilidade ou exatidão. As fontes revisam o histórico que publicam, às vezes anos depois, então os números aqui podem mudar. Podemos alterar ou descontinuar qualquer parte do serviço a qualquer momento.",
      },
      attribution: {
        title: "Atribuição e licenciamento dos dados",
        body: "Os conjuntos de dados de origem seguem sendo propriedade de quem os publica e são usados sob suas respectivas licenças abertas. Onde a licença exige atribuição ou tratamento share-alike do dado derivado, o WattSteer cumpre; esses avisos aparecem junto ao dado que cobrem. O registro de usinas derivado do ANEEL SIGA é oferecido sob a Open Database License (ODbL) v1.0 e pode ser baixado em forma legível por máquina em GET /v1/plants.",
      },
    },
  },

  app: {
    shell: {
      backToLanding: "WattSteer — voltar para a página inicial",
      prototypeBadge: "PROTÓTIPO · DADOS DE FIXTURE",
      screens: {
        overview: "Visão da rede",
        explain: "Explicar",
        mitigate: "Mitigar",
        replay: "Máquina do tempo",
      },
      selection: {
        subsystem: "Subsistema",
        technology: "Tecnologia",
        run: "Rodada D−1",
        targetDay: "Dia alvo",
      },
    },

    technology: { WIND: "Eólica", SOLAR: "Solar" },

    stamp: {
      published: "{producer} · {run} · publicado {when} BRT",
      weatherRun: " · rodada meteorológica {run}",
      threshold: " · limiar {mw} MW",
      optimisedAgainst: "Otimizado contra a previsão publicada {when} BRT",
    },

    vintage: {
      point_in_time: "PONTO NO TEMPO",
      revision_optimistic: "OTIMISTA POR REVISÃO",
    },

    band: {
      medianMarked: "P50 marcada",
      strip: "P10 {p10}, P50 {p50}, P90 {p90}",
    },

    risk: {
      low: "Baixo",
      elevated: "Elevado",
      high: "Alto",
      caveat:
        "O risco é P(pelo menos uma hora acima do limiar), agrupado em faixas. As faixas são largas porque o classificador não é calibrado com precisão suficiente para justificar faixas mais estreitas — veja a curva de confiabilidade em Explicar.",
    },

    fan: {
      figure:
        "Perfil de curtailment para o dia seguinte, faixa de P10 a P90 em torno da mediana",
      thresholdMark: "limiar {mw} MW",
      medianLegend: "Previsão P50",
      bandLegend: "Faixa P10–P90",
      observedDefault: "Observado",
      hint: "Toque em uma hora para ler o intervalo",
      hourLabel: "Hora",
      exceedance: "P(acima do limiar)",
      expected: "Esperada E[Y]",
      splitReadout: "{wind} eólica · {solar} solar",
      hourFigure: "Hora {hour}: P50 {p50} MWh, P10 a P90 {p10} a {p90}",
    },

    dispatch: {
      figure:
        "Despacho horário: curtailment oferecido, o que cada ativo está programado para fazer e o estado de carga da bateria",
      offered: "Curtailment oferecido (MWh)",
      batteryCharge: "Bateria carregando (MW)",
      loadShiftUp: "Carga deslocada para dentro da hora (MW)",
      soc: "SOC da bateria (MWh, eixo direito)",
      discharge: "Descarga (abaixo da linha)",
      loadShiftDown: "Carga deslocada para fora da hora (abaixo da linha)",
    },

    drivers: {
      groups: {
        renewable_resource: "Recurso renovável",
        demand_level: "Nível de carga",
        net_surplus: "Superávit líquido",
        export_stress: "Estresse de exportação",
        ramp_shape: "Rampa e formato do dia",
        calendar_season: "Calendário e estação",
        recent_history: "Histórico recente",
        data_conditions: "Condições do pipeline e residual",
      },
      merged: "Todo o resto",
      mergedNote:
        "{count} grupos abaixo do corte, reunidos em uma barra só. As contribuições são somadas com seus sinais.",
      terms: {
        weekend: "fim de semana",
        weekday: "dia útil",
        importing: "importando",
        balanced: "equilibrado",
      },
      direction: { raises: "aumenta", lowers: "reduz", mixed: "atua nos dois sentidos" },
      contribution: "{phi} MWh",
      reading: "{feature}: observado {observed} · típico {typical}",
      hourDisagreement:
        "Atuou nos dois sentidos ao longo do dia — suas horas divergem em {value}.",
      demoted: "Uma regra colocou este grupo abaixo da dobra. A contribuição não muda.",
      figure: "{driver}: {share} do movimento atribuído, {direction} o risco",
      figureMixed: "{driver}: {share} do movimento atribuído, atuando nos dois sentidos",
      note: "As parcelas são do movimento atribuído para este subsistema-dia — a contribuição de cada grupo diante do tamanho de todas elas —, não do curtailment em si. Um driver que aumenta o risco não é causa de nenhum MWh cortado em particular.",
      scopeNote:
        "Estas barras explicam os MWh esperados do dia. Elas não explicam o P10, o P90, a largura da faixa nem o risco de o dia ter qualquer curtailment — essa probabilidade vem do ensemble de trajetórias, que é outra saída do modelo.",
    },

    /**
     * A narrativa determinística, uma frase por cláusula.
     *
     * Escrita em português, não traduzida do inglês: é a locale padrão do
     * produto e o leitor é operador de rede brasileiro. Cada `{placeholder}` é
     * um valor — número, data, hora de relógio ou o rótulo de um grupo em
     * `drivers.groups` — formatado por `narration.ts` na notação daqui, nunca
     * outra frase. As unidades vêm do formatador e não estão escritas aqui.
     *
     * O modelo elevou ou reduziu a *sua previsão*; nada aqui diz que uma
     * condição fez algo com a rede. `docs/domain-model.md` §10.
     */
    narration: {
      risk_low:
        "Para {subsystem_display_name} em {target_date}, o modelo lê o risco de curtailment acima de {threshold_mw} como baixo: {day_occurrence_probability} para ao menos uma hora, com {hours_p50_nonzero} horas de P50 acima de zero.",
      risk_elevated:
        "Para {subsystem_display_name} em {target_date}, o modelo lê o risco de curtailment acima de {threshold_mw} como elevado: {day_occurrence_probability} para ao menos uma hora, com {hours_p50_nonzero} horas de P50 acima de zero.",
      risk_high:
        "Para {subsystem_display_name} em {target_date}, o modelo lê o risco de curtailment acima de {threshold_mw} como alto: {day_occurrence_probability} para ao menos uma hora, com {hours_p50_nonzero} horas de P50 acima de zero.",
      magnitude:
        "Ele espera {day_expected_mwh} no dia inteiro contra um dia típico de {baseline_expected_mwh}, uma diferença de {total_attributed_mwh} que os oito grupos de drivers repartem entre si.",
      peak: "A maior hora é {peak_hour_local}, com mediana de {peak_power_p50_mw}.",
      driver_raises:
        "{code} eleva a previsão do modelo: {phi_mwh}, {share} do movimento atribuído, lendo {observed} contra um típico de {typical}.",
      driver_lowers:
        "{code} reduz a previsão do modelo: {phi_mwh}, {share} do movimento atribuído, lendo {observed} contra um típico de {typical}.",
      driver_raises_no_reading:
        "{code} eleva a previsão do modelo: {phi_mwh}, {share} do movimento atribuído. Sua variável de destaque não tem par observado-contra-típico neste dia, portanto nenhum é citado.",
      driver_lowers_no_reading:
        "{code} reduz a previsão do modelo: {phi_mwh}, {share} do movimento atribuído. Sua variável de destaque não tem par observado-contra-típico neste dia, portanto nenhum é citado.",
      top_two_share:
        "Os dois grupos juntos respondem por {top_two_share} do movimento atribuído.",
      hour_disagreement:
        "{code} agiu nos dois sentidos ao longo do dia: suas horas divergem em {hour_disagreement}.",
      flag_nothing_to_explain:
        "Uma regra reteve o ranking. A probabilidade de ocorrência do dia, {day_occurrence_probability}, fica abaixo da menor borda das faixas de risco, {lowest_risk_bin_edge}, e {hours_p50_nonzero} horas têm P50 acima de zero.",
      flag_attribution_is_noise:
        "Uma regra reteve o ranking. O movimento atribuído, {sum_abs_attributed_mwh}, não supera o próprio erro amostral de fundo, {attribution_stderr_mwh}.",
      flag_stale_inputs_run_age:
        "Uma regra sinalizou as entradas: a rodada meteorológica por trás desta previsão tinha {weather_run_age_hours} no fechamento.",
      flag_stale_inputs_coverage:
        "Uma regra sinalizou as entradas: apenas {weather_centroid_coverage} dos centroides meteorológicos estavam disponíveis.",
      flag_stale_inputs_headline:
        "Uma regra sinalizou as entradas: estes grupos ficaram sem leitura de destaque no momento da resposta — {null_headline_features}.",
      flag_unmodelled_outage_regime:
        "Uma regra sinalizou o regime: em {date}, o dia liquidado mais recente, o motivo {top_reason} respondeu por {top_reason_share} da energia constrained-off, e nenhum dado ingerido carrega disponibilidade de transmissão para o modelo ler.",
    },

    reliability: {
      figure:
        "Diagrama de confiabilidade: probabilidade prevista contra frequência observada",
      axis: "probabilidade prevista (%)",
      note: "Pontos abaixo da linha de identidade tracejada são excessivamente confiantes: menos horas ultrapassaram o limiar do que a probabilidade prevista daquela faixa prometia. A área do ponto é o número de horas na faixa.",
    },

    overview: {
      metaTitle: "Visão da rede — WattSteer",
      title: "Visão da rede",
      lede: "Risco de curtailment para o dia seguinte em {date}, por subsistema. Todo número é um intervalo P10/P50/P90, não um ponto.",
      rowFigure: "{subsystem}: abrir Explicar",
      rowEnergy: "Energia cortada esperada",
      rowPeak: "pico {low}–{high} MW",
      profileSubtitle: "Perfil de 24 horas, P10–P90",
      dailyEnergy: "Energia cortada, dia inteiro",
      dailyEnergyNote:
        "O total do dia é uma previsão conjunta lida do ensemble de trajetórias. Não é a soma das P90 horárias nem a soma das P50 — nenhum quantil soma, medianas incluídas.",
      peakPower: "Pico de potência horária",
      peakPowerNote:
        "A maior hora dentro de um dia sorteado, no mesmo ensemble. Limiar em vigor: {mw} MW no grão de subsistema.",
      grainNote:
        "O grão da previsão é o subsistema. O curtailment observado é publicado por entidade de reporte — um conjunto, na maior parte — e os motivos de restrição só existem lá; veja Explicar.",
      fixtureTitle: "Estes números são uma fixture",
      fixtureNote:
        "A Visão da rede renderiza uma fixture determinística e não lê nenhuma API, que é o que permite a ela existir numa exportação estática. Nenhum artefato de modelo está promovido para atendimento, então não há previsão do dia seguinte para desenhar no lugar — não uma pequena, nenhuma. Os componentes, as unidades e as faixas são os do próprio produto; os números dentro deles não são previsão de coisa alguma.",
      map: {
        title: "Os quatro subsistemas",
        subtitle: "Mesma classe de risco das linhas abaixo",
        figure:
          "Mapa do Brasil dividido nos quatro subsistemas do ONS, cada um sombreado pela sua classe de risco de curtailment. As quatro regiões também aparecem como linhas logo abaixo.",
        region: "{subsystem}: risco {risk}, cerca de {probability}. Abrir Explicar.",
        boundaryNote:
          "Fronteiras elétricas, não regiões geográficas: o Maranhão está no subsistema Norte, o Acre e Rondônia estão no Sudeste/Centro-Oeste, e Mato Grosso, Mato Grosso do Sul, Goiás e o Distrito Federal também.",
        source: "Limites: IBGE, Malhas Territoriais (dados abertos governamentais).",
      },
    },

    split: {
      title: "Eólica e solar",
      subtitle: "Dois escalares, sem faixa",
      expected: "Energia cortada esperada, dia inteiro",
      expectedNote:
        "E[Y], publicada ao lado da faixa e não dentro dela. Não é o meio do intervalo: com massa parada em “nenhum corte”, a expectativa fica acima da mediana, e num dia calmo a mediana é zero cravado enquanto a expectativa não é.",
      note: "O previsor tem uma cabeça por subsistema, então eólica e solar são uma divisão dessa expectativa e nada além disso. Não existe faixa eólica nem faixa solar para desenhar, e é por isso que escolher uma tecnologia ali em cima destaca um destes dois números em vez de filtrar a previsão.",
      emphasised: "em destaque",
    },

    explain: {
      metaTitle: "Explicar — WattSteer",
      title: "Por que {subsystem}?",
      lede: "O que o modelo está lendo em {date}, e quanto disso vale acreditar.",
      riskTitle: "Risco de curtailment",
      riskSubtitle: "P(qualquer hora acima do limiar)",
      magnitude: "Magnitude esperada, dia inteiro",
      magnitudeNote: "Condicionada a o dia ultrapassar o limiar em alguma hora.",
      peakPower: "Pico de potência horária",
      narrationTitle: "Narrativa",
      narrationSubtitle: "Gerada no idioma solicitado",
      narration:
        "O modelo coloca o curtailment em {subsystem} acima do limiar de {mw} MW na maior parte do dia. A maior contribuição isolada é {top}, cuja variável de destaque {feature} marca {observed} contra um típico de {typical}, seguida por {second}. As duas juntas respondem por {share} do movimento atribuído. A faixa fica larga nas horas de ombro porque o classificador de ocorrência está perto de meio a meio ali — leia a P10 como “pode não ultrapassar o limiar de jeito nenhum”, e não como um número pequeno.",
      narrationNoteModel:
        "Escrita por um modelo de linguagem a partir da tabela de atribuição abaixo. Ela reapresenta os números; não acrescenta nenhum.",
      narrationNoteTemplate:
        "Montada a partir da tabela de atribuição abaixo por um template fixo, sem nenhum modelo de linguagem envolvido. Ela reapresenta os números; não acrescenta nenhum.",
      narrationWithheld:
        "Uma regra de domínio retirou a narrativa gerada para este dia: {codes}. A atribuição abaixo segue intacta — todos os oito grupos de drivers, cada um com o seu número.",
      narrationSourceModel: "Fonte: modelo de linguagem",
      narrationSourceTemplate: "Fonte: template fixo",
      driversTitle: "Atribuição de drivers",
      driversSubtitle: "SHAP, no grão de subsistema",
      reliabilityTitle: "Confiabilidade",
      reliabilitySubtitle: "Previsto vs frequência observada",
      reliabilityNote:
        "{hours} horas de {from} a {to}. A janela inteira é anterior ao início da ingestão, então ela é avaliada contra a reapresentação atual do passado feita pelo ONS, e não contra o que era conhecível na época.",
      reasonsTitle: "Motivos de restrição observados",
      reasonsSubtitle: "Apurados pelo ONS para {date}",
      grainConjunto: "motivo observado no grão de conjunto",
      grainPlant:
        "motivo observado no grão de usina — esta usina é sua própria entidade de reporte",
      reasonLegend:
        "Códigos de motivo: REL indisponibilidade externa (rede) · CNF exigência de confiabilidade · ENE energético (sobreoferta) · PAR restrição por parecer de acesso. Origem: LOC local, SIS sistêmica. O motivo de um conjunto nunca é alocado às usinas que o compõem — isso seria apresentar uma alocação como observação, e o WattSteer não calcula nenhuma.",
      next: "A seguir:",
      nextMitigate: "O que absorveria isso →",
    },

    mitigate: {
      metaTitle: "Mitigar — WattSteer",
      title: "O que dá para fazer?",
      lede: "{subsystem}, {date}. Armazenamento e demanda flexível dimensionados contra a previsão do dia seguinte.",
      // --- flex-optimizer 08: a postura, declarada em vez de oferecida -------
      postureTitle: "Um plano, uma promessa",
      postureSubtitle: "Planejado na mediana · prometido na borda inferior",
      postureRule:
        "No dia, cada ativo carrega o valor programado ou o que estiver de fato sendo cortado, o que for menor — e descarrega o valor programado ou o que o estado de carga permitir, o que for menor. Os ativos absorvem o que é de fato cortado e nunca mais do que isso.",
      postureWhy:
        "Por isso planejar contra a mediana não é o mesmo que supor que a mediana vai se confirmar. Se o dia vier pequeno, os ativos simplesmente absorvem menos, o número abaixo cai e nada é importado da rede. É isso que permite ao plano ser otimista enquanto o número citado permanece conservador — e é por isso que você não precisa escolher um quantil para obter uma resposta.",
      floorTitle: "O piso",
      floorLabel: "Energia recuperada na borda inferior",
      floorSentence:
        "Este plano recupera {floor} MWh se cada hora ficar na borda inferior da sua faixa de previsão. É esse o número para citar a outra pessoa.",
      floorMedian: "Na realização mediana",
      floorHigh: "Na realização alta",
      floorBesideNote:
        "Mostrados ao lado do piso e não à frente dele: uma promessa conservadora não deve esconder o potencial, e o potencial não é a promessa.",
      notJointTitle: "O que o piso não diz",
      notJointBody:
        "Um perfil P10 hora a hora não é uma afirmação de 90 % de confiança sobre o dia. O plano é viável contra a borda inferior de cada hora; a probabilidade conjunta de todas as 24 horas ficarem em ou acima da sua própria borda não é 90 %, não é calculada e não é afirmada. Quantis não somam.",
      deliveredTitle: "Recuperado não é entregue",
      deliveredSubtitle: "No envelope de planejamento",
      storedLabel: "Ainda armazenado no fim do horizonte",
      lossLabel: "Perdido no ciclo completo",
      deliveredNote:
        "A energia absorvida é medida na fronteira com a rede: é energia renovável que teria sido desperdiçada e em vez disso entrou em um ativo. O que o ativo entrega depois é menor pela perda de ciclo completo, com parte dela ainda dentro da bateria à meia-noite — não há meta de estado de carga final, porque exigir uma penalizaria a absorção no dia planejado para servir um dia que este horizonte não cobre.",
      refusalTitle: "Este cenário foi recusado",
      refusalNote:
        "A mesma tabela que o gateway aplica antes de construir um modelo, rodando aqui sobre o link com que você chegou. Nada foi corrigido: uma entrada consertada produz um plano para uma frota que você não descreveu, e nada na tela diria isso.",
      refusalReset: "Recomeçar da frota de referência",
      shareNote:
        "A barra de endereços é o cenário. Copie o link e quem receber vê esta frota, este dia e este valor assumido — não há conta, nada é salvo, e o botão voltar e um favorito funcionam como deveriam.",
      steps: {
        no_action: "Sem ação",
        battery: "+ Bateria",
        battery_and_load: "+ Carga flexível",
      },
      reveal: "Revelar",
      hidden: "Oculto — revele para ver o que este passo recupera.",
      remaining: "MWh restantes",
      baselineStep: "O dia como previsto, sem nada despachado.",
      stepRecovered: "{recovered} MWh recuperados na realização P50",
      avoided: "Curtailment evitado",
      realisationLow: "Na realização baixa",
      realisationMedian: "Na realização mediana",
      realisationHigh: "Na realização alta",
      avoidedNote:
        "A parcela cai conforme o evento cresce: uma frota fixa cobre menos de um dia maior, então a realização alta fica abaixo da mediana. A realização baixa fica abaixo das duas por outro motivo — um plano não absorve energia que nunca foi cortada, então em um dia pequeno os ativos simplesmente fazem menos. São três parcelas, não um intervalo, e a trilha percorre as três com a mediana marcada.",
      avoidedUndefined:
        "Indefinido, não zero. Um dia sem nenhuma hora acima do limiar não tem por que dividir, e um zero aqui seria lido como nada poderia ser evitado em vez de não havia nada a evitar.",
      economicTitle: "Cenário econômico (rotulado)",
      economicRate: "Valor assumido",
      economicNote:
        "A um valor assumido de {rate}/MWh, na realização mediana. Isto é um cenário, não um valor de liquidação, e é o único lugar em que R$ aparece. Nenhuma alegação de carbono decorre disso e nenhuma é feita.",
      economicOnlyMoney:
        "Mexa nele e só este número se mexe. O otimizador é denominado em energia, nunca em dinheiro, então nada do que ele recomenda depende de um preço que o WattSteer inventou.",
      solvingTitle: "Resolvendo",
      solvingNote:
        "O Otimizador de flexibilidade está montando e resolvendo o MILP para esta frota. Ele responde dentro da requisição — não há job para consultar — então isto deve sumir antes de você terminar de ler.",
      solvingLive:
        "Esta tela lê uma API ao vivo e não pode ser pré-renderizada. O POST /v1/optimize monta e resolve o MILP, que não roda no navegador — então uma exportação estática traz esta nota e nenhum plano, e permanece nela. Para dimensionar uma frota, aponte a build para um gateway em execução com EXPO_PUBLIC_API_URL, ou suba um localmente com bun run api e recarregue. Visão da rede e Explicar não precisam de nenhum dos dois.",
      economicNoPlan:
        "Sem plano, sem valor. Nada foi despachado nesta etapa, então não há o que precificar.",
      dispatchTitle: "Despacho",
      dispatchSubtitle: "{step} · o plano programado, no envelope de planejamento",
      dispatchScheduled:
        "Isto é o que os ativos estão programados para fazer contra a previsão mediana, com o estado de carga da bateria desenhado ao lado. No dia, a regra de execução acima corta as duas pernas, então a trajetória realizada é esta ou menor — nunca maior.",
      batteryTitle: "Bateria",
      loadTitle: "Carga flexível",
      assetSubtitle: "Entrada de cenário, não um inventário",
      reset: "Voltar para {power} MW / {energy} MWh + {shift} MW",
      footnote:
        "O ONS não publica cadastro de ativos de flexibilidade, então todo parâmetro acima é uma suposição sua. Mitigar é uma ferramenta hipotética, não um inventário — o cenário é codificado na URL em vez de salvo, então compartilhar é só mandar o link.",
    },

    assets: {
      decrease: "Diminuir {label}",
      increase: "Aumentar {label}",
      batteryPower: "Potência (MW)",
      batteryEnergy: "Energia (MWh)",
      roundTrip: "Eficiência de ciclo completo",
      initialSoc: "Estado de carga inicial",
      batteryNote:
        "Duração de {hours} horas. A eficiência se divide em uma perna de carga e uma de descarga (√RTE cada); a perda entra de forma assimétrica no balanço do estado de carga.",
      loadConnection: "Limite de conexão (MW)",
      loadShift: "Potência deslocável (MW)",
      loadWindow: "Janela de deslocamento (h)",
      loadDailyEnergy: "Energia diária (MWh)",
      loadNote:
        "A energia diária é conservada por construção: cada hora deslocada para cima é compensada por deslocamentos para baixo dentro da janela, então a carga consome os mesmos MWh de qualquer jeito.",
    },

    replay: {
      metaTitle: "Máquina do tempo — WattSteer",
      title: "E se o WattSteer estivesse rodando?",
      lede: "Um dia passado, reexecutado contra a safra de previsão disponível em D−1 e avaliado contra o que o ONS apurou.",
      dayLabel: "{date} · {subsystem}",
      honestyTitle: "O que esta reexecução é, e o que ela não é",
      provenance: {
        served: "EM SERVIÇO",
        fold_holdout: "RETIDO NO FOLD",
      },
      provenanceServedNote:
        "A previsão nesta tela é a que o WattSteer de fato publicou, em {published} — antes de o dia que ela descreve ter começado. Nenhuma versão do modelo poderia ter visto o dia, então isto é um contrafactual no sentido estrito, e não uma reconstrução.",
      provenanceFoldHoldoutNote:
        "Este dia cai no fold de teste {fold} da validação walk-forward, e a previsão vem do artefato daquele fold ({artifact}) — nunca do modelo que está em serviço hoje. Esse artefato foi treinado em {trainFrom} – {trainTo} e calibrado em {calibrationFrom} – {calibrationTo}; nenhuma das duas janelas contém este dia, e ambas são reconferidas contra o registro do próprio artefato a cada leitura, em vez de aceitas por confiança.",
      revisionOptimisticNote:
        "Este dia é anterior ao início da ingestão ({goLive}). O ONS reescreve o histórico no lugar, sem marcador de versão, então o valor apurado acima é a reapresentação atual do dia feita pelo ONS, não o que foi publicado na época. As safras anteriores são irrecuperáveis e isso nunca poderá ser corrigido retroativamente.",
      pointInTimeNote:
        "Este dia é posterior ao início da ingestão ({goLive}), então todo valor aqui é o que era genuinamente conhecível na época — uma leitura as-of, não a reapresentação de hoje.",
      vintageExtentNote:
        "Isso afeta {affects}. Não afeta {exempt}: cada um carrega como instante de publicação a rodada que o produziu, então a rodada D−1 contra a qual esta reexecução planejou é aquela rodada.",
      vintagePart: {
        settled_actuals: "o valor apurado contra o qual este dia é avaliado",
        lagged_actual_features:
          "as variáveis de valores apurados defasados (as horas certas, possivelmente com os valores errados)",
        weather_run: "a rodada meteorológica",
        dessem: "o DESSEM",
        ons_programming: "a programação do ONS",
      },
      revisionPremiumUnmeasured:
        "O tamanho dessa ressalva não foi medido. Só se torna mensurável quando o ONS reapresentar dias que o WattSteer guarda nas duas safras, e até lá nenhum número é oferecido no lugar.",
      revisionPremiumMeasured:
        "Medida sobre os dias guardados nas duas safras, a reapresentação vale em média {mwh} MWh de energia recuperada — o quanto uma reexecução otimista quanto a revisões deve ser descontada.",
      scenarioNote:
        "A energia recuperada é o que este despacho alcança sob este cenário contra esta safra de previsão. É uma propriedade do cenário, não do dia, e mudar qualquer parâmetro de ativo muda o resultado.",
      claimsNote:
        "MWh recuperados e % evitado são as únicas alegações feitas. Nenhuma economia de carbono decorre de energia renovável recuperada sem um modelo de emissões marginais, e nenhuma é oferecida.",

      headlineRecovered: "Energia que a frota teria recuperado",
      scoredOnObserved: "Avaliado sobre o dia apurado, não sobre a previsão",
      headlineSentence:
        "{recovered} MWh dos {actual} MWh que o ONS apurou, absorvidos pela frota abaixo sob a regra de execução: no dia, um ativo aceita o valor programado ou o valor que está de fato sendo cortado, o que for menor.",
      floorLabel: "Piso prometido em D−1",
      floorMetLabel: "Piso alcançado",
      floorMet: "Sim",
      floorMissed: "Não",
      floorMarginLabel: "Margem sobre o piso",
      floorNote:
        "O piso é a recuperação simulada na P10 — o que foi prometido antes de o dia acontecer. Alcançá-lo é uma alegação empírica que o produto confere dia a dia, nunca um teorema: um dia apurado não é obrigado a ficar acima da envoltória P10 em todas as horas.",

      headlineAvoided: "Curtailment evitado",
      avoidabilityNote:
        "Energia recuperada sobre o dia apurado inteiro. Um dia que veio maior do que o previsto rende uma fração menor, porque a frota é fixa e o denominador não é.",
      avoidabilityUndefined:
        "Indefinido, e mostrado como travessão em vez de 0 %. Nenhuma hora deste dia chegou a {mw} MW, então não havia curtailment a evitar — o que é uma afirmação diferente de um plano que não evitou nada.",
      headlineCurtailed: "Energia renovável cortada",
      denominatorNote:
        "O dia local inteiro, e o denominador de toda fração desta tela. Nunca o total do episódio: uma porcentagem cujo denominador se move com o limiar melhoraria apenas por o episódio ter sido desenhado mais apertado.",

      compareTitle: "O dia, de três formas",
      compareSubtitle: "Apurado vs previsto vs o que teria sobrado",
      rowActual: "Cortado — apurado pelo ONS",
      rowActualNote: "{hours} horas contíguas acima de {mw} MW, pico de {peak} MW.",
      rowForecast: "O que a rodada D−1 disse",
      rowForecastNote:
        "P10–P90 sombreada, P50 sólida. Um total conjunto do dia, nunca a soma dos quantis horários.",
      rowRemaining: "Restante depois da frota",
      rowRemainingNote:
        "O que o dia apurado ainda continha depois de a frota ter aceitado o que o plano programou e o que a hora de fato ofereceu.",

      hourlyTitle: "Hora a hora",
      hourlySubtitle: "O que foi previsto, e o que aconteceu",
      settledActual: "Apurado pelo ONS",

      planVsExecutedTitle: "O plano, e o que ele teria feito",
      planVsExecutedSubtitle: "Programado contra executado — duas séries, nunca uma",
      planVsExecutedFigure:
        "Gráfico horário: o curtailment apurado em barras, com a absorção programada e a executada como duas linhas",
      seriesActual: "Apurado pelo ONS",
      seriesScheduled: "Programado em D−1",
      seriesExecuted: "Executado no dia",
      planVsExecutedNote:
        "Onde a linha executada fica abaixo da programada, a previsão veio alta e a energia programada nunca esteve lá para ser aceita. Onde as barras ficam acima das duas, a previsão veio baixa: curtailment real que o plano nunca pediu, deixado de lado de propósito — aceitá-lo seria uma reotimização contra informação que o plano não tinha, e valorizaria justamente os dias em que a previsão mais errou.",

      foresightLabel: "O melhor que qualquer plano teria feito sabendo a resposta",
      foresightRecovered: "Recuperado com previsão perfeita",
      foresightAvoidability: "Fração do dia",
      foresightGap: "Quanto a previsão custou",
      foresightNote:
        "Retrospecto, e rotulado como tal: este plano foi construído sobre o próprio dia apurado, o que nenhuma previsão pode ser. É um limite superior e nunca uma alegação de recuperação, e a diferença ao lado é o único uso honesto dele — quanto uma previsão melhor teria valido neste dia, para esta frota.",

      episodesTitle: "Episódios",
      episodesSubtitle: "Uma visão de leitura do dia, carregando os próprios parâmetros",
      episodeRow:
        "{from} → {to} · {hours} h · {mwh} MWh · pico {peak} MW · limiar {mw} MW · tolerância de intervalo {gap} h",
      episodeNote:
        "Um episódio é uma visão de leitura das horas de curtailment, nunca uma linha armazenada. Cada um acima carrega o limiar e a tolerância de intervalo de {gap} hora que o produziram, porque uma duração sem carimbo não pode ser comparada com outra — um limiar diferente produziria episódios diferentes a partir dos mesmos dados.",

      batteryTitle: "Bateria",
      loadTitle: "Carga flexível",
      fleetSubtitle: "A frota contra a qual este dia é avaliado",
      fleetReset: "Voltar à frota de referência",
      fleetNote:
        "Mexer em qualquer um destes replaneja o dia e o reavalia contra o que aconteceu. Não é capaz de reprever: a previsão é uma linha histórica fixada e nada neste caminho de requisição carrega um modelo, que é a propriedade que faz disto uma reexecução e não uma simulação.",

      replayingTitle: "Reexecutando",
      replayingNote:
        "Uma otimização e cinco passagens de avaliação contra o dia apurado. Nada é desenhado até que todas tenham respondido — uma tela pela metade seria números de duas frotas diferentes lado a lado.",
      replayingLive:
        "Esta tela lê uma API ao vivo e não pode ser pré-renderizada. O GET /v1/replay replaneja o dia e o avalia com o único simulador, que não roda no navegador — então uma exportação estática traz esta nota e nenhum número, e permanece nela. Para ver um dia reexecutado, aponte a build para um gateway em execução com EXPO_PUBLIC_API_URL, ou suba um localmente com bun run api e recarregue. Visão da rede e Explicar não precisam de nenhum dos dois.",

      observedOnlyTitle:
        "Este dia não pode ser reexecutado, e esta é a cláusula que ele reprovou",
      observedOnlyNote:
        "O que é oferecido no lugar é o próprio dia: o perfil apurado, seus episódios e o limite abaixo, que não precisa de previsão e portanto não precisa de modelo. Não há valor recuperado nem fração evitada — não zero, ausente, pois o WattSteer nunca foi solicitado a planejar este dia.",

      refusalTitle: "Nenhuma reexecução para esse pedido",
      refusalNote:
        "Nada é desenhado no lugar. Um número com uma ressalva em cima é um número que acaba citado sem a ressalva, e é exatamente por isso que esta tela recusa em vez de rotular.",
      refusalReset: "Voltar à frota de referência",
      shareNote:
        "A frota vive na barra de endereços, então este link é o estado inteiro — inclusive o dia e os ativos contra os quais ele foi avaliado.",
    },
  },
};
