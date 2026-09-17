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
    /** AGPL §13: the offer of corresponding source, on the page it is served from. */
    sourceLink: "Código-fonte",
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
    VOICE_NOT_CONFIGURED: "A voz não está configurada nesta instalação.",
    VOICE_UNAVAILABLE: "Não foi possível iniciar a sessão de voz.",
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
    eyebrow: "Curtailment do dia seguinte · rede brasileira",
    headline: {
      lead: "Hoje conseguimos saber que houve curtailment.",
      accent: "O WattSteer avisa antes.",
    },
    // The deck's own subhead (p. 01, "a camada de decisão entre o plano do ONS
    // e a operação em tempo real") carries this sentence in Portuguese, so
    // this is the original and `en` is the rendering of it — the reverse of
    // the usual direction here. See the note on `en.hero.sub`.
    sub: "A camada de decisão entre o plano do dia seguinte do ONS e o tempo real: o risco de corte de amanhã por subsistema, o que o empurrou para cima e a faixa em volta — nunca um número solto.",
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
      "A linha de valor esperado é a que soma: os quatro valores esperados dão exatamente o número nacional ao lado, e você pode conferir. As P50 não somam — a P50 de uma soma só é a soma das P50 se os quatro subsistemas se moverem juntos, e eles não se movem — e faixas não são aditivas de jeito nenhum. É por isso que o número nacional é um valor esperado e não uma mediana.",
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
      "Uma previsão de curtailment que diz {value} MWh e mais nada é um número se passando por fato. O WattSteer publica P10, P50 e P90 juntos e desenha a distância entre eles, para que a largura da incerteza seja tão visível quanto o meio dela. Onde um número genuinamente não tem faixa — um valor histórico medido — ele é marcado como observado, para que a ausência signifique alguma coisa.",
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
    /** Alt text for the 1200×630 share card (`public/og.png`). */
    imageAlt: "WattSteer — inteligência de curtailment para a rede brasileira",
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
    /** The top-nav link. Same words as the footer's, one row apart. */
    navLink: "Apresentação",
    /** The landing page's deck section — see the English dictionary. */
    sectionCta: "Abrir a apresentação",
    slideAlt:
      "O primeiro slide da apresentação: R$ 6,5 bilhões em energia limpa desperdiçada em 2025, ao lado do mapa dos quatro subsistemas do Brasil.",
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

  briefing: {
    label: "Briefing visual",
    dismiss: "Fechar",
    /** Read out to a screen reader as the sequence advances. */
    position: "Cena {index} de {total}",
    /** Shown when the browser refused to play audio, or the reader has it off. */
    silent: "Sem áudio — a narração está escrita abaixo.",
    refusalTitle: "Nada para apresentar",
    recommendationBody:
      "Pré-posicione a flexibilidade na janela acima. O plano está em Mitigar, com a frota que você descreveu.",
    done: "Fim do briefing",
    again: "Rever",
    scenes: {
      title: "Briefing",
      mapFocus: "Onde",
      forecastCurve: "Hora a hora",
      observedCurve: "O que foi liquidado",
      constraint: "Motivos registrados",
      comparison: "Plano x executado",
      counterfactual: "E se?",
      recommendation: "Ação sugerida",
      sources: "Fontes",
    },
  },
  app: {
    shell: {
      backToLanding: "WattSteer — voltar para a página inicial",
      noModelBadge: "NENHUM MODELO PROMOVIDO",
      /** Names the `tablist` around the four screen pills for a screen reader. */
      screensLabel: "Telas",
      /** The accordion control on a collapsed section, and on an open one. */
      expand: "Abrir",
      collapse: "Recolher",
      /**
       * The two sections of Visão da rede, named short.
       *
       * Not in `screens` any more: that node is the nav row's labels, and the
       * row names places a reader travels to. These are places on the page the
       * reader is already on. The voice agent still names them — "Abri
       * Explicar para você" — which is why they are copy and not a comment.
       */
      sections: {
        explain: "Explicar",
        mitigate: "Mitigar",
      },
      screens: {
        overview: "Visão da rede",
        replay: "Máquina do tempo",
      },
      selection: {
        subsystem: "Subsistema",
        run: "Rodada D−1",
        /* Per lane now, so the sentence names this run rather than the
           deployment: one gate can be promoted while the other is refused. */
        runUnavailable: "Esta rodada não tem modelo promovido — escolhê-la não muda nada",
        targetDay: "Dia alvo",
      },
    },

    lane: {
      heading: "Lanes de atendimento:",
      condition: {
        no_artifact: "sem artefato",
        present_unpromoted: "recusado pelo portão",
        promoted: "promovido",
        unresolvable: "indeterminável",
      },
      noLanes: "nenhuma reportada",
      modelUnreachable: "não foi possível alcançar o serviço de modelagem",
      note: "Uma lane é um conjunto de variáveis, um portão e um limiar. Uma previsão só é publicada a partir de uma lane promovida, então enquanto nenhuma das {count} acima estiver promovida não há o que publicar — o portão recusar um candidato é o portão funcionando, e o detalhe está em GET /v1/meta.",
    },

    technology: { WIND: "Eólica", SOLAR: "Solar" },

    /**
     * O copiloto de voz — `components/voice/*`.
     *
     * As mesmas uniões que o código percorre: `VoiceStatus` (sete, duas
     * próprias da WattSteer) e `ToolRefusalCode` (treze). A falha que isso
     * previne é invisível — um estado ou uma recusa sem frase é uma pílula em
     * branco ou um cartão com `undefined`, justamente quando quem lê está mais
     * atento.
     *
     * As recusas são escritas como **o agente falando**, não como o aplicativo
     * relatando. `execute.ts` separa os códigos pelo que quem ouve precisa
     * ouvir, e escrevê-los na terceira pessoa gastaria essa separação à toa.
     */
    voice: {
      idle: "Pergunte ao WattSteer",
      panelTitle: "WATTSTEER AI",
      expand: "Abrir o painel de voz",
      collapse: "Recolher o painel de voz",
      close: "Encerrar a sessão de voz",
      status: {
        idle: "Pergunte ao WattSteer",
        connecting: "Conectando…",
        listening: "Ouvindo você…",
        thinking: "Pensando…",
        speaking: "Respondendo…",
        acting: "Abrindo para você…",
        error: "A voz parou. Toque para tentar de novo.",
      },
      transcript: {
        you: "Você",
        agent: "WattSteer",
        empty:
          "Pergunte sobre uma região, por que o dia está assim, ou o que dava para fazer.",
      },
      action: {
        navigate: "Abri {screen} para você",
        focused: "Mudei a seleção para você",
        highlighted: "Destaquei {subsystem}",
        highlightCleared: "Tirei o destaque",
        briefing: "Briefing aberto",
        refused: "Isso eu não fiz",
        noScreenChange: "Sem mudar de tela — a resposta está onde você já está.",
        scenarioChanged: "cenário atualizado",
      },
      refusal: {
        unknown_tool: "Isso não é algo que eu consiga fazer por aqui.",
        malformed_arguments: "Não consegui ler o que pedi. Pode repetir?",
        unexpected_argument: "Isso não faz parte do que eu estava fazendo.",
        missing_argument: "Preciso saber qual deles você quer dizer.",
        unknown_subsystem: "Não conheço esse subsistema — conheço N, NE, SE e S.",
        unknown_technology: "Conheço duas fontes: eólica e solar.",
        unknown_run: "São duas rodadas de D−1: 00Z e 12Z.",
        unknown_driver: "Esse não é um dos grupos de fatores que a atribuição ordena.",
        unknown_episode: "Esse dia não está no catálogo da Máquina do tempo.",
        unknown_question_kind:
          "Não entendi que tipo de pergunta era essa, então não abri um briefing.",
        value_out_of_range: "Esse valor está fora do que os próprios controles aceitam.",
        ambiguous_replay: "Me diga um dia ou quantos dias atrás — não os dois.",
        no_episode_for_relative_day: "Não há nada tão antigo assim no catálogo.",
        scenario_refused: "Esse parque não é um que o otimizador aceitaria.",
      },
      mic: {
        deniedTitle: "Sem microfone",
        deniedBody:
          "O navegador não deixou a WattSteer ouvir você. Digite — as mesmas perguntas funcionam.",
      },
      typed: {
        label: "Digitar uma pergunta em vez de falar",
        placeholder: "Digite uma pergunta",
        send: "Enviar",
      },
    },

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

    observed: {
      badge: "Observado",
      stamp: "Observado · liquidado até {when} BRT · {lag} h de atraso",
      window24h: "Últimas 24 h até {hour} BRT",
      windowDay: "Dia liquidado, {date}",
      rowEnergy: "Energia cortada, últimas 24 h",
      selectedFigure: "{mwh} MWh liquidados · eólica {wind} · solar {solar}",
      noFan:
        "Não há faixa P10–P90 sobre estas barras, e não pode haver: uma faixa é saída de modelo e estas horas estão liquidadas. O que está desenhado é o que aconteceu, megawatt-hora a megawatt-hora.",
      dayTotal: "Energia cortada liquidada, dia inteiro · {subsystem}",
      dayTotalNote:
        "As horas liquidadas do dia, somadas. Observações somam exatamente — é a mesma soma que permite existir um total nacional — então este número pode ser calculado aqui, onde uma faixa de previsão nunca poderia.",
      peakHour: "Maior hora liquidada · {subsystem}",
      peakHourWindow: "{hour}h BRT de {date}",
      peakHourNote:
        "Uma energia em MWh, não uma potência em MW: o ONS publica energia por hora, e a faixa de pico de potência que uma previsão informa é uma afirmação do modelo sobre o formato dentro daquela hora. Não há modelo nenhum hoje, então nenhum número desses é mostrado.",
      splitTitle: "Eólica e solar",
      splitSubtitle: "{subsystem} · liquidado, duas medições",
      splitTotal: "Energia cortada liquidada, dia inteiro",
      splitNote:
        "O ONS liquida as duas frotas separadamente — o grão publicado é subsistema, tecnologia e hora — então estas são duas medições e o total é a soma delas. A versão de previsão deste painel é o contrário: uma expectativa modelada, dividida em duas.",
      emptyDay:
        "O dia liquidou sem nenhum corte neste subsistema, o que é uma medição e não um número faltando.",
      nationalTitle: "As últimas 24 horas, nos quatro subsistemas",
      nationalSubtitle: "Uma soma de quatro medições, e ela é exata",
      nationalLabel: "Energia liquidada em constrained-off, os quatro subsistemas",
      nationalNote:
        "Este número é a soma das quatro linhas de subsistema da mesma janela — o gateway diz isso no próprio campo, `derived: sum_of_four`. Não é a linha SIN do ONS, que o WattSteer nunca usa porque ela contaria em dobro o que já está nas quatro. Medições somam exatamente; nenhum quantil de previsão soma.",
    },

    overview: {
      /**
        Pergunta 5 do briefing do operador, respondida com o que é verdade.

        O briefing pede "causa provável". Não existe esse modelo — o previsor
        tem uma cabeça por subsistema e produz uma quantidade, não um motivo.
        REL/CNF/ENE são o registro do ONS sobre dias que já aconteceram, então
        a frase carrega a data e nunca fica solta ao lado de uma previsão.
      */
      causeLabel: "Motivo dominante",
      causeSentence: "{reason} respondeu por {share} da energia cortada em {date}.",
      causeNote:
        "Motivo apurado pelo ONS sobre um dia liquidado, no grão em que ele publica — conjunto e subsistema. Não é uma previsão de motivo: o WattSteer prevê quanto será cortado, não por quê.",
      /** Pergunta 4 do briefing do operador: "quando?" — dito, não desenhado. */
      windowLabel: "Janela crítica",
      windowRange: "{from}h–{to}h BRT",
      windowPeak: "Pico às {peak}h · {mwh} MWh",
      windowScattered: "{hours} horas no dia esperam corte; esta é a maior sequência.",
      windowNone: "Nenhuma hora do dia é mais provável cortar do que não cortar.",
      metaTitle: "Visão da rede — WattSteer",
      title: "Visão da rede",
      lede: "Risco de curtailment para o dia seguinte em {date}, por subsistema. Todo número é um intervalo P10/P50/P90, não um ponto.",
      /*
        The row *selects*; it no longer navigates. The label said "abrir
        Explicar" because pressing it did, which is the defect this screen
        carried: one gesture, two plausible meanings, and it silently did the
        one that takes the reader off the screen.
      */
      ledeObserved:
        "O que a rede já liquidou, por subsistema. Todo número aqui é medido; nenhum é previsão, porque nenhum modelo está promovido.",
      rowFigure: "{subsystem}: selecionar",
      rowExplain: "Explicar",
      rowExplainLabel: "Explicar {subsystem}",
      selectedBadge: "Selecionado",
      selectedTitle: "Região selecionada",
      selectedNote:
        "Os quatro painéis abaixo — perfil de 24 horas, eólica e solar, energia do dia e pico — são todos sobre esta região. Escolher outra troca os quatro no lugar, sem sair da tela.",
      selectedAbsent:
        "Nenhum número de previsão para esta região hoje, porque nenhum modelo está promovido. O que vem abaixo é observado e vale igual.",
      rowEnergy: "Energia cortada esperada",
      rowPeak: "pico {low}–{high} MW",
      profileSubtitle: "Perfil de 24 horas, P10–P90",
      nationalTitle: "O dia, nos quatro subsistemas",
      nationalSubtitle:
        "Valor esperado — a única grandeza de previsão que soma entre subsistemas",
      dailyEnergy: "Energia cortada, dia inteiro · {subsystem}",
      dailyEnergyNote:
        "O total do dia é uma previsão conjunta lida do ensemble de trajetórias. Não é a soma das P90 horárias nem a soma das P50 — nenhum quantil soma, medianas incluídas.",
      peakPower: "Pico de potência horária · {subsystem}",
      peakPowerNote:
        "A maior hora dentro de um dia sorteado, no mesmo ensemble. Limiar em vigor: {mw} MW no grão de subsistema.",
      grainNote:
        "O grão da previsão é o subsistema. O curtailment observado é publicado por entidade de reporte — um conjunto, na maior parte de {subsystem} — e os motivos de restrição só existem lá; veja Explicar.",
      readingTitle: "Lendo a rede",
      /** Screen-reader name for the mark that a re-read is in flight. */
      refreshingLabel: "Atualizando os números da região selecionada",
      refusedTitle: "O gateway não respondeu",
      refusedNote:
        "Todos os painéis desta tela leem o gateway, inclusive os que não precisam de modelo, então não há o que mostrar enquanto isso. Os números não ficam guardados na página; recarregar depois que o serviço voltar é tudo o que falta.",
      absentTitle: "Sem previsão para este dia",
      absentNote:
        "As classes de risco, as faixas P10–P90 e os totais previstos do dia são saída de modelo, e não há nenhuma — por isso não aparecem. No lugar delas, cada painel responde o que os dados liquidados respondem sem modelo nenhum: megawatt-hora que o ONS já publicou, marcados como observados onde quer que apareçam.",
      settledTitle: "Liquidado nos quatro subsistemas",
      settledSubtitle: "Últimas 24 h até {hour} BRT · {lag} h de atraso",
      settledSplit: "eólica {wind} MWh · solar {solar} MWh",
      settledNationalNote:
        "Total nacional {mwh} MWh, a soma dos quatro. Observações somam exatamente, e é por isso que este total existe aqui e nenhuma faixa nacional de previsão existe.",
      settledDayTitle: "{subsystem} — o último dia liquidado",
      settledDaySubtitle: "Curtailment horário observado, {date}",
      settledDayNote:
        "Uma barra por hora local, eólica e solar somadas. Uma hora sem registro liquidado não desenha barra nenhuma: uma hora que liquidou em zero e uma hora que não liquidou são fatos diferentes.",
      settledDayEmpty: "Nenhum curtailment liquidado neste subsistema neste dia.",
      episodesTitle: "Episódios recentes",
      episodesSubtitle: "{from} a {to}, acima de {mw} MW",
      episodeColumns: {
        period: "Período",
        duration: "Duração",
        energy: "Energia",
        peak: "Pico",
      },
      episodeNote:
        "Um episódio é uma sequência de horas acima do limiar, unida por lacunas de no máximo {gap} h. Os dois parâmetros vão carimbados em cada episódio, porque fazem parte do que um episódio é.",
      episodesEmpty: "Nenhuma hora desta janela passou do limiar neste subsistema.",
      map: {
        title: "Os quatro subsistemas",
        subtitle: "Mesma classe de risco das linhas abaixo",
        figure:
          "Mapa do Brasil dividido nos quatro subsistemas do ONS, cada um sombreado pela sua classe de risco de curtailment. As quatro regiões também aparecem como linhas logo abaixo.",
        region: "{subsystem}: risco {risk}, cerca de {probability}. Selecionar.",
        keyboardNote:
          "As setas percorrem as quatro regiões e trocam a seleção; Enter seleciona a região em foco.",
        boundaryNote:
          "Fronteiras elétricas, não regiões geográficas: o Maranhão está no subsistema Norte, o Acre e Rondônia estão no Sudeste/Centro-Oeste, e Mato Grosso, Mato Grosso do Sul, Goiás e o Distrito Federal também.",
        titleObserved: "Os quatro subsistemas",
        subtitleObserved: "Energia cortada liquidada, últimas 24 h",
        figureObserved:
          "Mapa do Brasil dividido nos quatro subsistemas do ONS, cada um sombreado pela energia cortada que o ONS já liquidou nas últimas 24 horas, com esse número impresso na região. As quatro regiões também aparecem como linhas ao lado.",
        regionObserved:
          "{subsystem}: {mwh} MWh liquidados nas últimas 24 horas. Selecionar.",
        legendLow: "Menos",
        source: "Limites: IBGE, Malhas Territoriais (dados abertos governamentais).",
      },
    },

    split: {
      title: "Eólica e solar",
      /** Named. A panel that does not say whose numbers it holds cannot show
          a reader that the numbers changed under it. */
      subtitle: "{subsystem} · dois escalares, sem faixa",
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
      ledeAbsent:
        "O que o ONS registrou em {date}. Nenhum modelo está promovido, então não há diagnóstico — apenas o que foi observado.",
      riskTitle: "Risco de curtailment",
      riskSubtitle: "P(qualquer hora acima do limiar)",
      magnitude: "Magnitude esperada, dia inteiro",
      magnitudeNote: "Condicionada ao dia ultrapassar o limiar em alguma hora.",
      peakPower: "Pico de potência horária",
      readingTitle: "Lendo o diagnóstico",
      refusedTitle: "O gateway não respondeu",
      refusedNote:
        "Nem mesmo os motivos de restrição observados, que não precisam de modelo. Não há nada nesta tela que não venha do gateway.",
      absentTitle: "Nada a explicar neste dia",
      absentNote:
        "O risco, as duas faixas, a atribuição de drivers e a narrativa são todos saída de modelo, e não há nenhuma — um diagnóstico explica uma previsão, e nenhuma previsão foi publicada. Os motivos de restrição observados abaixo seguem intactos: são o que o ONS registrou sobre um dia que aconteceu.",
      reliabilityAbsentNote:
        "Uma curva de confiabilidade é propriedade de um modelo promovido, então não há nenhuma para desenhar. O cartão de um artefato recusado pelo portão não entra no lugar: uma curva de calibração aqui é a afirmação “é assim que está calibrado o modelo que você está lendo”, e não há modelo que alguém esteja lendo.",
      reasonsEmpty: "O ONS não registrou restrição para este subsistema neste dia.",
      causeMixed:
        "O motivo registrado mudou ao longo do dia; apenas um fica armazenado, o que é uma simplificação e não uma observação.",
      narrationTitle: "Narrativa",
      narrationSubtitle: "Gerada no idioma solicitado",
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
      ledeAbsent:
        "{subsystem}, {date}. Nenhum plano é desenhado — dimensionar flexibilidade exige uma previsão do dia seguinte, e não há nenhuma.",
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
      // --- a acurácia da previsão, item 3 do briefing da máquina do tempo ---
      accuracyTitle: "A previsão se sustentou?",
      accuracySubtitle: "O que o sistema dizia na véspera, contra o que o ONS liquidou",
      accuracyForecast: "Previsto (P50)",
      accuracySettled: "Liquidado",
      accuracyError: "Erro",
      accuracyPlacement: {
        inside:
          "O dia liquidou dentro da faixa P10–P90 ({p10}–{p90} MWh), que é onde a previsão dizia que cairia.",
        above:
          "O dia liquidou acima da P90 ({p90} MWh): cortou mais do que a faixa previa.",
        below:
          "O dia liquidou abaixo da P10 ({p10} MWh): cortou menos do que a faixa previa.",
      },
      accuracyNote:
        "Uma faixa P10–P90 é feita para ser ultrapassada em cerca de um dia a cada cinco — uma faixa nunca ultrapassada é larga demais para agir sobre ela. Por isso esta tela diz onde o dia caiu e não atribui nota. A fração de dias que caem dentro é propriedade de muitos dias, não de um: é o trilho `coverage_p10_in_band` do gate, medido sobre uma dobra inteira.",
      metaTitle: "Máquina do tempo — WattSteer",
      title: "E se o WattSteer estivesse rodando?",
      lede: "Um dia passado, reexecutado contra a safra de previsão disponível em D−1 e avaliado contra o que o ONS apurou.",
      ledeAbsent:
        "Um dia passado, e o que o ONS apurou sobre ele. Não há nada reexecutado para avaliar ao lado.",
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
      episodesSubtitle:
        "Uma visão de leitura do dia, acima de {mw} MW — carregando os próprios parâmetros",
      episodeColumns: {
        period: "Período",
        duration: "Duração",
        energy: "Energia",
        peak: "Pico",
      },
      episodesEmpty: "Nenhuma hora deste dia passou do limiar neste subsistema.",
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
