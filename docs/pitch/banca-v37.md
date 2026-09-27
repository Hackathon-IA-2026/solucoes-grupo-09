# Banca simulada de 6 jurados — pitch v37 (11 slides)

Rodada em 27/09/2026. O agente leu **só as imagens dos slides**, sem roteiro, 20 segundos por slide.
Jurados: engenheiro eletricista (EE), software e IA (TI), engenheiro civil leigo (CIV), político (POL),
investidor-anjo do agronegócio (INV) e Luana Helsinger (LUA). Personas em `jurados/banca-simulada.md`.

## Notas

| Jurado | Nota | O que travou |
|---|---|---|
| Engenheiro eletricista | 6,0 | Contradição da devolução entre os slides 1 e 3; kWh e MWh misturados na tela do produto; faixa P10–P90 vendida como acerto |
| Software e IA | 6,0 | O slide 9 se desmente em duas linhas; nunca dizemos qual é o modelo |
| Engenheiro civil (leigo) | 6,5 | Slides 3 e 8 fazem perder a conta; MW e GW sem tradução |
| Político | 7,5 | Falta o impacto em reais por mês na conta do consumidor |
| Investidor-anjo | 4,5 | Nenhum cliente pagante, nenhuma carta de intenção; R$ 235 mil apresentado como fato; os 113 assinantes aparecem do nada |
| Luana Helsinger | 8,5 | Falta dizer o que acontece com a usina quando o modelo erra |

**Média 6,5.** Maior nota que a Luana já deu ao deck; menor nota do investidor até agora.

## Veredito: NÃO PASSA

| Critério | Resultado |
|---|---|
| Os seis entendem cada slide | Falha: slide 3 (contradição) e slide 8 (quatro porcentagens) |
| Média 7 ou mais, ninguém abaixo de 5 | Falha nos dois: média 6,5 e investidor em 4,5 |
| Os seis dizem o que oferecemos | Passa: todos formularam "aviso na véspera, por assinatura da geradora" |
| Nenhum dado técnico sem tradução | Falha: 100 MW, 296 GW, COPPE, P10–P90, kWh/MWh na tela |

## Os cinco pontos que mais atrapalham

**1. Contradição da devolução (slide 1 × slide 3).** O slide 1 diz que dos R$ 6,5 bi voltam R$ 4,4 bi (68%).
O slide 3 diz que 2 em cada 3 cortes não são devolvidos (33%). O caso Auren dá um terceiro número (59%).
Reescrita sugerida para o slide 3: "Quando o corte é para proteger a rede, a lei manda devolver. Quando é
porque sobrou energia, não devolve nada — e é esse tipo que mais cresce: hoje é 1 de cada 3 cortes, em 2029
serão 9 de cada 10."

**2. O corte de um dia não fecha com o do ano.** 35 bilhões de kWh no ano dão 96 milhões por dia no país
inteiro; os slides 5 e 8 mostram 219 a 227 milhões num único dia só no Nordeste. Falta uma frase de escala:
"18/09 foi um dia de corte pesado: sozinho, valeu por três dias médios do ano."

**3. O slide 8 vende calibração como acerto.** Uma faixa P10–P90 cobre 80% por construção; 83% é a faixa
cumprir o que promete, não afinação. E o "erro abaixo de 4%" é um dia só, escolhido por nós. Trocar pelo
erro médio dos 328 dias, mesmo que o número seja feio: a banca perdoa o número, não perdoa o recorte.

**4. O slide 9 se desmente e inventa 113 assinantes.** O título diz que o valor será medido no piloto e o
cartão ao lado afirma "vale R$ 235 mil/ano". E os 113 assinantes não têm origem declarada. Reescrita:
marcar R$ 235 mil como conta nossa a ser provada no piloto e derivar os assinantes de uma base ("1 em cada
10 das 1.132 usinas eólicas: R$ 6,8 milhões por ano").

**5. Unidades sem tradução, inclusive dentro do produto.** 100 MW, 296 GW, COPPE, P10–P90. E, na tela do
slide 6, convivem "110,0k kWh", "175,1k kWh" e "P50 200,1k MWh": 110,0k kWh seriam 110 MWh, valor
implausível para um subsistema. É um erro de unidade na interface, visível no frame congelado.

## As duas mudanças desta versão

### Slide 6, demonstração com o vídeo: funcionou, com uma ressalva séria

"Não é maquete: é o produto no ar" responde à dúvida que todo jurado carrega, e o quadro mostra densidade
de produto que nenhuma maquete tem. Os três marcadores da esquerda dão roteiro de leitura enquanto o vídeo
roda. É o slide que sobe a nota do investidor e do jurado de tecnologia.

A ressalva: a tela congelada já entrega o erro de unidade citado acima, e o engenheiro eletricista lê isso
em 20 segundos. Se não der para corrigir a interface e regravar, escolher um frame de pôster sem esses
cartões. Outras três observações: 50 segundos são 28% de um pitch de 3 minutos, e 35 seriam suficientes; o
vídeo deve terminar num frame legível com resultado, porque é nele que o slide fica congelado; e a legenda
"Demonstração gravada · 50 s" tem contraste ruim sobre o mapa.

### Slide 11, o bloco "Devolvemos" e o pedido duplo: é a maior alta desta versão

Responde exatamente à pergunta da Luana sobre o que devolvemos ao ecossistema de onde tiramos os dados, e é
o que leva a nota dela a 8,5 e a do político a 7,5. O pedido duplo é melhor do que pedir dinheiro: pedir
auditoria externa é a coisa mais forte que uma startup de inteligência artificial pode dizer diante de uma
banca de governança.

O que melhorar: o bloco é o melhor argumento do slide e está com cara de rodapé, em pílulas pequenas
competindo com o QR e os logos; as três promessas não têm prazo, e uma data curta transforma promessa em
compromisso verificável; os seis logos de alvos custam mais do que rendem, porque o investidor lê "zero
cliente" em letra garrafal; e "100 usinas" no slide 11 briga com "113 assinantes" no slide 9.

## Números conferidos

Fecham: R$ 6,5 − 4,4 = 2,1; 35 de 561,6 bilhões de kWh = 6%; 18 milhões de casas × 160 kWh × 12 = 34,6
bilhões; 1.469 − 1.242 = 227 MW médios = 15%; 529 − 312 = 217; 1,4 milhão de casas × 160 kWh = 224 milhões;
R$ 5 mil × 12 = R$ 60 mil; 113 × 5.000 = 565.000; 9 + 15 + 15 + 5 = 44 anos; 296 GW no corpo e 296,8 no
rodapé.

Não fecham: os três percentuais de devolução (68%, 33%, 59%); o corte diário contra o anual; as unidades na
tela do produto; o valor cravado no slide 5 contra a faixa no slide 8; "erro abaixo de 4%" com subtítulo "3
das 4 regiões na faixa"; 95% de chance no slide 5 contra "probabilidade de 100%" na tela; 113 assinantes
contra 100 usinas; R$ 4,4 bi é o topo de uma faixa que começa em 2,7; "triplicou num ano" subvende o
próprio gráfico (0,4 para 35 em três anos); e as fontes divergem entre os slides 6, 7 e 11.

## As quatro correções que virariam PASSA

1. Reconciliar a devolução numa frase no slide 3, separando corte por confiabilidade de corte por sobra.
2. Trocar o "erro abaixo de 4%" pelo erro médio dos 328 dias no slide 8 e explicar que 83% é a faixa
   cumprindo o que promete.
3. Reescrever o slide 9 marcando R$ 235 mil como hipótese a medir e derivando os assinantes de uma base
   declarada.
4. Traduzir MW, GW e COPPE, e arrumar a unidade na tela antes de regravar o vídeo.

Com as quatro, a média projetada é de cerca de 7,3, com ninguém abaixo de 6.
