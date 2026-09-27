# Roteiro do pitch (v37)

Tempo estimado: **2 min 56 s** (436 palavras a 150 palavras por minuto). Limite: 3 min.
Gerado junto com os slides (`build_2026_v37.py`): mudou um slide, o roteiro muda junto. Desde a v36 o slide funciona sozinho; a fala complementa, não explica.

## Slide 1 · R$ 6,5 bi de prejuízo em 2025; até R$ 4,4 bi a recuperar. (19 s)

Em 2025, as usinas de vento e sol do Brasil perderam seis bilhões e meio de reais com cortes, e o corte quase triplicou em um ano. Nós somos o WattSteer. Vendemos previsão que vira receita para quem gera energia. E o corte é só o começo.

*Fontes:* R$ 6,5 bi: perdas dos geradores eólicos e solares com cortes em 2025, Caderno do Hackathon IA 2026 / Volt Robotics · quase triplicou: 12,7 para 35 bilhões de kWh de 2024 para 2025 (ONS, RT DGL 0189/2025; Volt Robotics) · até R$ 4,4 bi: devolução dos cortes de set/2023 a nov/2025, Lei 15.269/2025 (estimativas de R$ 2,7 a 4,4 bi: MME; Volt Robotics; Canal Solar) · mapa: Felipe Menegaz, Wikimedia Commons, CC BY-SA 3.0

## Slide 2 · Energia limpa jogada fora: 35 bilhões de kWh em 2025, um ano de luz para 18 milhões de casas. (23 s)

Quando os fios não dão conta, o ONS desliga usinas de vento e sol: um de cada cinco kWh em 2025, oitenta por cento no Nordeste. E o corte continua até 2030. O custo do corte aumenta a conta de luz: a devolução sai de um encargo que todos pagam, e a térmica ligada no lugar custa mais.

*Fontes:* ONS, RT DGL 0189/2025 (46, 389 e 1.447 MW médios em 2022-2024) · Caderno do Hackathon IA 2026 / Volt Robotics (4.021 MW médios em 2025, cerca de 20% da geração eólica e solar) · 79%: Canal Solar sobre dados do ONS (jan-abr/2026) · até 2030: ONS, PEN 2026, cap. 4 (corte médio de 2 a 3 GW em toda safra de ventos) · quem paga: compensação da Lei 15.269/2025 custeada pelo ESS (Encargo de Serviços do Sistema), R$ 2,7 a 3,3 bi (MME) e cerca de R$ 3 bi (ANEEL, jan/2026) · R$ 65 mi = 1% de R$ 6,5 bi

## Slide 3 · Nosso cliente investiu bilhões para gerar e perde centenas de milhões quando o ONS corta. (16 s)

A Auren gerou quinze por cento a menos do que podia e perdeu quinhentos e vinte e nove milhões; a lei devolve trezentos e doze. E a devolução está acabando: dois em cada três cortes já não são devolvidos.

*Fontes:* Auren, release de resultados 4T25 e 2025 (03/03/2026), pp. 4-6: impacto do curtailment de R$ 529,5 mi (R$ 451,8 mi eólica, R$ 77,6 mi solar), geração de 1.242 MW médios contra potencial de 1.469; parcela ressarcível pela Lei 15.269/2025 estimada pela empresa em cerca de R$ 312 mi · Ventos do Piauí II e III: 409,2 MW por R$ 2,1 bi (CanalEnergia, 2025) · comparação: Serena perdeu R$ 39,7 mi só no 1T25 e recebeu R$ 9,8 mi (CanalEnergia; MegaWhat)

## Slide 4 · Hoje entregamos uma coisa: o aviso da véspera. (17 s)

Hoje entregamos uma coisa: o aviso da véspera, com quanto, quando e por quê. Quem é cortado paga a diferença ao preço da hora, e essa conta chega um mês depois. Manutenção na janela e prova para o ressarcimento ainda vamos construir.

*Fontes:* Recuperação: a CCEE recontabiliza pela REN ANEEL 1.109/2024 e entrega pela plataforma DRI; nós conferimos parque a parque, meia hora a meia hora, e contestamos a classificação do corte · Lei 15.269/2025 e MME Portaria 140/2026 (cortes de set/2023 a nov/2025) · bateria: LRCAP 2026 com 296,8 GW cadastrados, 71% no NE (EPE, 03/08/2026; Canal Solar)

## Slide 5 · Na véspera, cinco respostas: vai cortar, quanto, quando, por quê e onde. (14 s)

Na véspera, o dono abre o WattSteer e vê cinco respostas: vai cortar, quanto, quando, por quê e onde. Tem dúvida? Pergunta por texto ou voz. A IA comunica, os modelos calculam, o dono decide.

## Slide 6 · Não é maquete: é o produto no ar. (3 s)

Em cinquenta segundos, o produto no ar.

*Fontes:* Gravação de tela do WattSteer (https://www.wattsteer.com/app), 26/09/2026: mapa do dia por região, explicação do motivo e Máquina do Tempo (acerto medido em 328 dias liquidados)

## Slide 7 · Duas semanas, quatro fundadores, sem investimento. Tudo isto já está no ar. (12 s)

Em duas semanas, quatro pessoas, sem captar um centavo. O dado é público; o modelo treinado, o acervo do ONS que montamos e o histórico casado todo dia, não.

*Fontes:* Stack na AWS do evento (wattsteer.com) · técnica: LightGBM hurdle com intervalos conformalizados (P10/P50/P90), SHAP com regras do ONS (REL/CNF/ENE), RAG sobre documentos do ONS com resposta por texto ou áudio, Replay temporal, guardrails · ONS Dados Abertos (constrained-off, balanço por subsistema, carga, intercâmbio, DESSEM) · ANEEL SIGA · Open-Meteo

## Slide 8 · Em 328 dias que o modelo não viu, o corte caiu dentro da nossa faixa em 83%. (21 s)

E nós provamos. A Máquina do Tempo testa num dia que o modelo nunca viu, só com o que se sabia na véspera. Em trezentos e vinte e oito dias que o modelo não viu, o corte caiu dentro da nossa faixa em oitenta e três por cento. A meta era oitenta.

*Fontes:* Máquina do Tempo do WattSteer (https://www.wattsteer.com/app/time-machine): Nordeste, 18/09/2026, previsão da véspera às 9h (rodada 00Z) contra o liquidado pelo ONS; modelo F6 treinado só até 30/06/2026, sem nenhuma informação futura; P10-P90 de 93 a 220 mil MWh na véspera anterior; cobertura de 83% em 328 dias liquidados (meta 80%)

## Slide 9 · Preço: R$ 5 mil por mês. O que o aviso economiza, o piloto vai medir. (13 s)

Cobramos cinco mil por mês. Com o aviso, a usina já remarca a manutenção para o dia do corte: numa usina de cem megawatts, duzentos e trinta e cinco mil por ano.

*Fontes:* Valor por usina: estimativa da equipe (Guilherme Machado, 26/09), cenário-base com dados de EPE, ONS, ANEEL e IBGE: manutenção flexível programada nas janelas de corte (R$ 235 mil/ano por 100 MW; R$ 90 mi/ano no Brasil) e compra antecipada da energia de reposição (vantagem histórica de R$ 8 a 14/MWh; R$ 250 a 400 mil/ano por ativo com corte alto); não é resultado observado · BNB/ETENE, Caderno Setorial 415 (1.132 usinas eólicas no Brasil, 1.026 no NE, set/2025) · R$ 60 mil/ano = R$ 5 mil/mês (hipótese); R$ 68 mi = 1.132 x R$ 60 mil · comissão: 10 a 20% de R$ 2,7 a 4,4 bi (MME; Volt Robotics; Canal Solar)

## Slide 10 · Quatro fundadores. Construímos isto em duas semanas. (10 s)

Quatro fundadores: setor elétrico, software, IA e produto. Em duas semanas mudamos de rota várias vezes. Steer é isso: corrigir o rumo sem parar.

*Fontes:* Trajetórias: bios escritas por cada fundador

## Slide 11 · Nascemos do dado aberto do ONS, no Rio. E devolvemos. (28 s)

Nascemos do dado aberto do ONS e devolvemos: acervo aberto e placar de acerto público. Em noventa dias, o piloto; em um ano, cem usinas; em três anos, o padrão do país, com baterias. Se em duas semanas fizemos isto, imaginem em dois anos. Vocês viram um produto; o que construímos foi um time que não para. Nosso pedido: uma geradora e um laboratório da COPPE para auditar o método. Obrigado.

*Fontes:* QR: https://www.wattsteer.com/app
