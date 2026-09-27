# Checkpoint de clareza do pitch

**Regra inegociável (Guilherme, 26/09/2026):** quem vai ouvir o pitch dificilmente é técnico. Todo slide precisa ser entendido por pessoas de idades, setores e experiências diferentes. **Nenhuma versão vai para o time sem passar pelas duas etapas abaixo.**

## Tela e entrega (organização, via Guilherme Machado, 26/09)

A tela do evento é horizontal, **3840x1080 (32:9)**. A entrega é **.pptx ou vídeo (.mp4/.avi)**, enviada como **link** do PowerPoint ou do Canva. **Nunca PDF.** Os slides usam CSS 1920x540 e são renderizados a 2x; `build_entrega.py` gera o .pptx (slides em imagem, tela cheia) e o .mp4 (cada slide pelo tempo da sua fala).

## Formato (Guilherme, 26/09): 3 minutos, uma ideia por slide

A banca pediu **uma ideia por slide** ("não compramos ingresso para o filme"): o slide é curto e complementa quem apresenta; o detalhe vai para a fala. Alvo: **3 minutos**.

## Slide que funciona sozinho (Guilherme, 26/09 à noite, desde a v17)

O slide minimalista (título curto + cartões de cinco palavras, sentido só na fala) foi abandonado: dependia demais dos apresentadores, e o deck circula sem eles (entrega em .pptx/.mp4, checkpoint da organização, mentores). **Teste de aceitação: se alguém encaminhar o deck a um investidor, ele brilha os olhos só com o que está no documento?** Cada slide tem três camadas, e continua uma ideia por slide, sem jargão, letras de 18 px ou mais:

1. **Título = a afirmação completa**, com o número e a consequência (o que um investidor lê em 3 segundos).
2. **Evidência** ocupa o espaço: um visual ou até três cartões com número e fonte curta, não frases soltas.
3. **"E daí"** em uma linha de destaque: o que isso vale para quem paga.

A fala complementa com história e exemplo; não explica o slide. Limite de palavras por slide: **60, com tolerância de 10%** (até 66; Guilherme, 26/09 23:16) e frases de até **16 palavras** (desde a v27, 26/09 23:10: o time achou a v25/v26 densas). Antes: 80 (v17 a v26) e 40 (até a v16). O teste de leitores leigos passa a ser feito **só com os PNGs, sem o roteiro**, e a pergunta final vira "o que estão oferecendo e você quer saber mais?".

## Fonte no rodapé (Machado e Guilherme, 26/09 ~22h, desde a v19)

Todo dado que aparece no slide tem a fonte resumida numa linha de rodapé (`nota=` em cada `slide(...)`, classe `fontes nota`, 18 px, fora da contagem de palavras). A fonte completa, com links, continua no roteiro embaixo da fala. Nada de número sem fonte no rodapé.

## Etapa 0 · roteiro sincronizado (terceiro checkpoint)

Os slides e o roteiro de fala saem da **mesma fonte** (`build_final_vN.py`: cada slide carrega sua fala). O build **recusa gerar** se algum slide estiver sem fala ou se a fala passar de 3 minutos (150 palavras por minuto). Toda alteração no pitch atualiza o roteiro (`roteiro-pitch-final-vN.md`) no mesmo build, e os dois são postados juntos.

## Etapa 1 · varredura automática

```bash
python3 clareza.py wattsteer-pitch-final-vN.html
```

Aponta, por slide, jargão técnico (com sugestão de troca), sigla sem explicação, frase com mais de 22 palavras e **slide com mais de 40 palavras** (uma ideia por slide). Precisa terminar em `TOTAL: 0 pendência(s)`.

- Termo técnico explicado logo depois entre parênteses passa, ex.: "35 TWh (bilhões de kWh)".
- O rodapé de fontes fica fora da checagem: é lá que o termo técnico (LightGBM, SHAP, MILP, REL/CNF/ENE) mora, para dar credibilidade a quem procurar.
- As bios do slide da equipe ficam fora: cada integrante é dono da própria bio. Sugestões de simplificação vão para a pessoa, não são aplicadas.
- Achou um jargão novo que a varredura deixou passar? Acrescente ao dicionário `JARGAO` do `clareza.py`.

## Etapa 1b · legibilidade no telão

```bash
python3 legibilidade.py wattsteer-pitch-final-vN.html   # precisa do daemon cdpd
```

Mede no Chrome a menor letra visível de cada slide: **nenhuma abaixo de 18 px** (pedido do Vitor, 26/09: "letras todas enxergáveis"). Por isso as fontes não ficam mais no slide: vão para o roteiro, embaixo da fala de cada slide.

## Etapa 2 · teste com a banca de cinco perfis (Guilherme, 26/09 22:39; substitui os leitores leigos)

Um agente recebe **só os prints dos slides** (sem roteiro: o deck vai ser encaminhado e precisa funcionar sozinho) e lê como cinco jurados, cada um vendo cada slide por 20 segundos:

1. **Engenheiro eletricista** do setor elétrico.
2. **Profissional de tecnologia** (software e IA).
3. **Engenheiro de construção civil.**
4. **Político** (deputado ou secretário estadual).
5. **Investidor-anjo milionário do agronegócio.**
6. **Luana Helsinger** (jurada confirmada; persona em `docs/pitch/jurados/luana-helsinger.md`, só com informação pública e profissional): CEO da Made in Rio, organizadora do hackathon; ética e governança de IA, impacto traduzido em termos simples, ecossistema do Rio como capital de IA da América Latina.

Para cada slide e cada jurado: (a) o que o slide diz, em uma frase; (b) o que ele não entende ou o que o irrita (sigla, número, unidade, jargão); (c) a impressão que fica da startup (positiva, neutra, negativa). No fim, cada jurado diz em uma frase o que o WattSteer oferece, quem paga e por que agora, e dá a nota de recepção (0 a 10).

**Critério (não negociável):** cada um dos cinco entende o slide em si; a recepção é boa (nota média 7 ou mais, nenhum abaixo de 5); os cinco sabem dizer o que estamos oferecendo; nenhum dado técnico fica no slide sem tradução para leigo. Dado técnico que só um perfil entende sai do slide e vai para o roteiro ou para a demo.

**Publicação obrigatória (Guilherme, 26/09 22:52):** toda vez que um teste automatizado desses terminar, o resultado vai para o tópico Pitch do Discord, no formato usado para o slide 5 (uma linha por jurado com o que entendeu e o que travou, notas, os 5 pontos que mais atrapalham, veredito), para o time saber como está. **Um jurado só não entender não obriga ajuste:** não é para agradar a todos; publica-se o retorno da banca e o time decide. Ajuste é obrigatório quando dois ou mais travam no mesmo ponto ou quando a média fica abaixo de 7.

Por que: a apresentação vai ser encaminhada para pessoas de áreas diferentes, e a clareza da mensagem é o que posiciona a startup na banca (Guilherme, 26/09: "a clareza da mensagem que queremos passar é essencial e não negociável").

### Prompt do agente (copiar e trocar os caminhos)

> Você vai ler os slides de um pitch de 3 minutos em imagens (`<pasta>/s01.png` a `s10.png`), um por um, com a ferramenta Read, só os slides, sem roteiro. Simule cinco jurados de uma banca de hackathon, cada um vendo cada slide por 20 segundos: (1) engenheiro eletricista do setor elétrico; (2) profissional de tecnologia (software e IA); (3) engenheiro de construção civil; (4) político (deputado ou secretário estadual); (5) investidor-anjo milionário do agronegócio; (6) Luana Helsinger, organizadora do hackathon (Made in Rio), com foco em ética e governança de IA, impacto real em termos simples e ecossistema do Rio. Para cada slide e jurado, de forma compacta: (a) o que o slide diz em uma frase; (b) o que ele não entende ou o que o irrita; (c) impressão da startup (positiva, neutra, negativa). No fim, cada jurado: o que o WattSteer oferece, quem paga, por que agora, e nota de recepção de 0 a 10. Entregue os 5 pontos que mais atrapalham, com reescrita em português simples, e o veredito PASSA / NÃO PASSA: os cinco entendem cada slide; média 7 ou mais e nenhum abaixo de 5; os cinco dizem o que oferecemos; nenhum dado técnico sem tradução. Seja honesto e rigoroso. Não leia outros arquivos.

## Onde está registrado

- Script: `docs/pitch/clareza.py`
- Resultado de cada versão: anotar na mensagem ao time ("passou no checkpoint de clareza") e no `pitch_estado.md` do ciclo.
