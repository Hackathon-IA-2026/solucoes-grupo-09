"""Pitch final alt7-v1: estrutura oficial do workshop "Como fazer um killer pitch?" da organização (problema, solução,
como funciona, tração, mercado, modelo de negócio, time, futuro), tela 3840x1080 (CSS 1920x540 a 2x) e roteiro gerado junto.
Checkpoints em docs/pitch/CHECKPOINT-CLAREZA.md. Entrega: .pptx e .mp4 (build_entrega.py), nunca PDF."""
import re
from pathlib import Path

HERE = Path(__file__).parent
V48 = (HERE / 'wattsteer-pitch-v48.html').read_text()
OUT = HERE / 'wattsteer-pitch-2026-alt7-v1.html'  # sufixo 2026: os nomes wattsteer-pitch-alt7-v1..v48 são do deck do Ideathon
ROTEIRO = HERE / 'roteiro-pitch-2026-alt7-v1.md'
PALAVRAS_POR_MINUTO = 150
TEMPO_MAXIMO_S = 180

head, *sections = V48.split('<section class="slide"')
head = head.replace('Pitch Ideathon IA COPPE 2026 (v48)', 'Pitch Hackathon IA COPPE 2026 (alt7-v1)')
head = head.replace('</style>', """
  .todo{ color:var(--warning) !important; border-bottom:2px dashed var(--warning); }
  .stat.sm .num.todo{ font-size:30px; white-space:nowrap; }
  .traj{ display:flex; gap:8px; margin-top:14px; }
  .traj span{ font-size:12.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; padding:6px 14px; border-radius:999px; border:1px solid var(--hair2); color:var(--t3); }
  .traj span.on{ background:var(--lime); color:var(--onlime); border-color:var(--lime); }
  .traj span.done{ color:var(--lime); border-color:var(--limeline); }
  .motor{ background:var(--surface); border:1px solid var(--hair); border-radius:14px; padding:12px 16px; flex:1; }
  .motor .tt{ font-size:12.5px; font-weight:700; letter-spacing:.14em; color:var(--lime); text-transform:uppercase; }
  .motor .q{ font-size:16.5px; font-weight:600; margin-top:4px; }
  .motor .how{ font-size:13px; line-height:1.4; color:var(--t2); margin-top:4px; }
  .motor.hi{ background:var(--limecard); border-color:var(--limeline); }
  .price{ display:flex; align-items:baseline; gap:10px; }
  .price .v{ font-size:26px; font-weight:700; color:var(--lime); white-space:nowrap; }
  .price .u{ font-size:13.5px; color:var(--t2); }
  .col2{ display:grid; grid-template-columns:1fr 1fr; gap:26px; }
  .step{ display:flex; gap:16px; align-items:flex-start; background:var(--surface); border:1px solid var(--hair); border-radius:16px; padding:16px 20px; }
  .step .k{ width:40px; height:40px; border-radius:12px; background:var(--lime); color:var(--onlime); font-weight:800; font-size:20px; display:flex; align-items:center; justify-content:center; flex:none; }
  .step h4{ margin:0; font-size:19px; font-weight:600; }
  .step p{ margin:4px 0 0; font-size:14.5px; line-height:1.45; color:var(--t2); }
  .seg{ display:grid; grid-template-columns:1.1fr 1.3fr 1.2fr .8fr; gap:0; background:var(--surface); border:1px solid var(--hair); border-radius:16px; overflow:hidden; }
  .seg > div{ padding:10px 14px; font-size:13.5px; line-height:1.4; color:var(--t2); border-top:1px solid var(--hair); }
  .seg > div.h{ font-size:11.5px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--t3); border-top:none; background:var(--sunken); }
  .seg > div b{ color:var(--t1); }
  .seg > div.first{ background:var(--limecard); }
  .flow.xl .st{ padding:34px 30px; font-size:24px; } .flow.xl .st b{ font-size:32px; margin-bottom:10px; }
  .tline.big .tnode .w{ font-size:20px; } .tline.big .tnode p{ font-size:28px; font-weight:600; color:var(--t1); }
  .card.tm .avimg{ width:84px !important; height:84px !important; margin-bottom:6px !important; }
  .card.tm{ padding:14px 12px !important; }
  .card.tm .nm{ font-size:19px !important; } .card.tm .hook{ font-size:17px !important; }
  .card.tm .hook{ font-size:15px; font-weight:700; color:var(--t1); margin-top:10px; line-height:1.3; }
  .card.tm .why{ font-size:12.5px; color:var(--lime); margin-top:8px; line-height:1.35; }
  .card.tm p{ font-size:11px !important; line-height:1.4 !important; color:var(--t3) !important; }
  .big{ font-size:60px; font-weight:700; line-height:1.1; letter-spacing:-.02em; margin:26px 0 0; max-width:1180px; }
  .big .hl{ color:var(--lime); } .big .hlg{ color:var(--grapel); }
  .one{ display:flex; gap:40px; align-items:center; margin-top:40px; }
  .word{ flex:1; text-align:center; background:var(--surface); border:1px solid var(--hair); border-radius:22px; padding:30px 16px; }
  .word .ico.big{ width:64px; height:64px; margin:0 auto; } .word .ico.big svg.i{ width:32px; height:32px; }
  .word .w{ font-size:28px; font-weight:700; margin-top:16px; }
  .word.hi{ background:var(--limecard); border-color:var(--lime); }
  .card.tm .hook{ font-size:15px; font-weight:700; color:var(--t1); margin-top:10px; line-height:1.3; }
  .card.tm .why{ font-size:13px; color:var(--lime); margin-top:8px; line-height:1.35; }
  .demo{ display:flex; gap:10px; align-items:center; }
  .demo .d{ flex:1; background:var(--surface); border:1px solid var(--hair2); border-radius:12px; padding:10px 14px; font-size:13.5px; color:var(--t2); line-height:1.35; }
  .demo .d b{ display:block; color:var(--t1); font-size:15px; }
  .demo .d .nb{ margin-right:6px; }
  /* legibilidade no telão: nenhuma letra visível abaixo de 18px (legibilidade.py) */
  .eyebrow{ font-size:18px !important; } .traj span{ font-size:18px !important; padding:6px 16px !important; }
  .lbl{ font-size:18px !important; } .capt{ font-size:18px !important; } .chart .ttl{ font-size:20px !important; }
  .card p, .card .cap{ font-size:20px !important; }
  .card.tm .rl{ font-size:18px !important; } .card.tm .nm{ font-size:22px !important; } .card.tm .hook{ font-size:20px !important; }
  .flow.xl .st{ font-size:24px !important; } .callout{ font-size:22px !important; }
  /* tela do evento: 3840x1080 (32:9). O CSS usa 1920x540 e o render sai a 2x */
  @page { size: 1920px 540px; margin: 0; }
  .slide{ width:1920px !important; height:540px !important; padding:34px 80px 0 90px !important; }
  .wide{ display:flex; gap:60px; align-items:center; height:400px; }
  .wide > .l{ flex:0.9; } .wide > .r{ flex:1.1; }
  .big{ font-size:50px; margin-top:0; }
  .sub2{ font-size:26px; line-height:1.35; color:var(--t2); margin:18px 0 0; }
  .sub2 b{ color:var(--lime); }
  .tm4{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; }
  .tm4 .c{ background:var(--surface); border:1px solid var(--hair); border-radius:16px; padding:14px 10px; text-align:center; }
  .tm4 img{ width:78px; height:78px; border-radius:50%; object-fit:cover; border:2px solid var(--limeline); display:block; margin:0 auto; }
  .tm4 .nm{ font-size:20px; font-weight:700; margin-top:8px; } .tm4 .rl{ font-size:18px; color:var(--lime); font-weight:600; margin-top:2px; }
  .tm4 .hk{ font-size:18px; color:var(--t1); margin-top:6px; }
  .step h4{ font-size:26px !important; }
  .cmp{ display:grid; grid-template-columns:150px 1fr; gap:14px 18px; align-items:center; }
  .cmp .k{ font-size:20px; font-weight:700; letter-spacing:.12em; color:var(--t3); text-transform:uppercase; }
  .cmp .v{ background:var(--surface); border:1px solid var(--hair2); border-radius:16px; padding:18px 22px; font-size:24px; line-height:1.35; color:var(--t2); }
  .cmp .v b{ color:var(--t1); } .cmp .v.ws{ background:var(--limews); border-color:var(--lime); color:var(--t1); } .cmp .v.ws b{ color:var(--lime); }
</style>""")


# ---- alt7-v1: o slide funciona sozinho (afirmação completa + evidência + "e daí"), ver CHECKPOINT-CLAREZA.md ----
head = head.replace('</style>', """
  .claim{ font-size:44px; font-weight:700; line-height:1.15; letter-spacing:-.02em; margin:0; }
  .claim .hl{ color:var(--lime); } .claim .hlg{ color:var(--grapel); }
  .edai{ margin-top:22px; font-size:24px; font-weight:700; line-height:1.3; color:var(--lime); border-left:5px solid var(--lime); padding-left:16px; }
  .edai small{ display:block; font-size:18px; font-weight:500; color:var(--t2); margin-top:4px; }
  .ev{ display:flex; gap:16px; }
  .ev .c{ flex:1; background:var(--surface); border:1px solid var(--hair); border-radius:16px; padding:18px 20px; }
  .ev .c .k{ font-size:18px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--t3); }
  .ev .c .n{ font-size:44px; font-weight:700; line-height:1.05; margin-top:8px; letter-spacing:-.02em; }
  .ev .c .n small{ font-size:24px; font-weight:600; }
  .ev .c p{ font-size:20px; line-height:1.35; color:var(--t2); margin:8px 0 0; }
  .ev .c.bad .n{ color:var(--grapel); } .ev .c.ws{ background:var(--limecard); border-color:var(--limeline); } .ev .c.ws .n{ color:var(--lime); }
  .step h4{ font-size:24px !important; } .step .k{ font-size:20px; }
  .step p{ font-size:19px !important; color:var(--t2); }
  .shot{ width:100%; border-radius:14px; border:1px solid var(--hair2); display:block; }
  .vert{ display:flex; flex-direction:column; gap:12px; }
  .vert .c{ background:var(--surface); border:1px solid var(--hair); border-radius:14px; padding:14px 18px; font-size:22px; line-height:1.3; color:var(--t2); }
  .vert .c b{ color:var(--t1); } .vert .c.ws{ background:var(--limecard); border-color:var(--limeline); }
  .slide{ position:relative; }
  .nota{ position:absolute; left:90px; right:80px; bottom:12px; font-size:18px !important; line-height:1.25; color:var(--t3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .nota b{ color:var(--t2); font-weight:600; }
</style>""")


def icon(name):
    return f'<svg class="i"><use href="#i-{name}"/></svg>'


def fontes(txt, lab='FONTES'):
    return f'<div class="fontes"><span class="lab">{lab}</span><div>{txt}</div></div>'


MAPA = re.search(r'<svg class="mapbr".*?</svg>', sections[0], re.S).group(0)
MAPA_CAPA = MAPA.replace('class="mapbr"', 'class="mapbr" style="width:100%; height:auto"')
SOLUCAO_URL = 'https://www.wattsteer.com/app'
SLIDES = []


def slide(html, fala, titulo='', nota=''):
    """Cada slide carrega a própria fala (roteiro) e a nota de rodapé com a fonte resumida (pedido do Machado e do Guilherme, 26/09)."""
    if nota:
        rotulo = 'Feito com' if nota.startswith('ONS Dados Abertos') else 'Fonte'
        html += f'<div class="fontes nota"><b>{rotulo}:</b> {nota}</div>'
    return {'html': html, 'fala': ' '.join(fala.split()), 'titulo': titulo}


def eyebrow(n, rotulo):
    return f'<div class="eyebrow"><span class="n">{n:02d}</span><span class="dot"></span>{rotulo}</div>'


def tela(n, rotulo, claim, edai, direita, l='0.95', r='1.05', edai_sub=''):
    """Slide de três camadas: afirmação completa (esquerda, em cima), evidência (direita), "e daí" (esquerda, embaixo)."""
    sub = f'<small>{edai_sub}</small>' if edai_sub else ''
    return (f'{eyebrow(n, rotulo)}<div class="wide" style="height:430px"><div class="l" style="flex:{l}"><h2 class="claim">{claim}</h2>'
            f'<div class="edai">{edai}{sub}</div></div><div class="r" style="flex:{r}">{direita}</div></div>')


def cards(itens):
    """Evidência em cartões: rótulo, número e explicação curta."""
    return '<div class="ev">' + ''.join(
        f'<div class="c{(" " + cls) if cls else ""}"><div class="k">{k}</div><div class="n">{n}</div><p>{p}</p></div>' for k, n, p, cls in itens) + '</div>'


def passos(itens, destaque=None):
    return '<div class="col" style="gap:10px">' + ''.join(
        f'<div class="step"{" style=\"border-color:var(--lime); background:var(--limews)\"" if i == destaque else ""}><div class="k">{i}</div><div><h4>{t}</h4>{("<p>" + p + "</p>") if p else ""}</div></div>'
        for i, (t, p) in enumerate(itens, 1)) + '</div>'



# ============ VERSÃO ALTERNATIVA, 7 SLIDES (pedido do Guilherme, 27/09) ============
# Ordem: problema, impacto, como ajudamos, como ganhamos (com caso real e alvos),
# onde estamos, quem somos (steer), para onde vamos (pedido). Texto curto, peso na ilustração.

GRAF = """<div class="chart" style="padding:16px 24px"><div class="ttl">Bilhões de kWh jogados fora</div>
    <svg viewBox="0 0 1000 300" width="100%" height="330" style="margin-top:6px">
      <line x1="30" y1="250" x2="970" y2="250" stroke="#3A3A3E"/>
      <rect x="80" y="247" width="150" height="3" rx="2" fill="#5A3F95"/>
      <rect x="300" y="225" width="150" height="25" rx="5" fill="#6B49B0"/>
      <rect x="520" y="160" width="150" height="90" rx="6" fill="#7C53D3"/>
      <rect x="740" y="18" width="150" height="232" rx="8" fill="#8D5DF6"/>
      <text x="155" y="236" fill="#F7F7F7" font-size="28" font-weight="700" text-anchor="middle">0,4</text>
      <text x="375" y="214" fill="#F7F7F7" font-size="28" font-weight="700" text-anchor="middle">3,4</text>
      <text x="595" y="148" fill="#F7F7F7" font-size="28" font-weight="700" text-anchor="middle">12,7</text>
      <text x="815" y="66" fill="#fff" font-size="44" font-weight="700" text-anchor="middle">35</text>
      <text x="155" y="288" fill="#A2A2AC" font-size="26" text-anchor="middle">2022</text>
      <text x="375" y="288" fill="#A2A2AC" font-size="26" text-anchor="middle">2023</text>
      <text x="595" y="288" fill="#A2A2AC" font-size="26" text-anchor="middle">2024</text>
      <text x="815" y="288" fill="#A2A2AC" font-size="26" text-anchor="middle">2025</text>
    </svg></div>"""

# 01 · o problema
SLIDES.append(slide(tela(1, 'O problema',
    'Todo dia o Brasil manda usinas de vento e sol <span class="hlg">pararem</span>.',
    'Não é acidente. É a rede que não dá conta.',
    GRAF), """
Todo dia o Brasil manda usinas de vento e sol pararem. Não é acidente: é a rede que não dá conta.
E isso saiu de quase nada para trinta e cinco bilhões de quilowatts-hora em três anos.
""", 'Todo dia o Brasil manda usinas de vento e sol pararem.',
    nota='ONS, RT DGL 0189/2025 e Volt Robotics: energia eólica e solar cortada em 2022, 2023, 2024 e 2025'))

# 02 · o impacto em reais
MAPA_IMP = MAPA.replace('class="mapbr"', 'class="mapbr" style="width:100%; height:auto; max-height:380px"')
SLIDES.append(slide(tela(2, 'O impacto',
    '<span class="hl">R$ 6,5 bilhões</span> perdidos em 2025. E a conta chega na sua casa.',
    'A devolução que a lei manda pagar sai do encargo que todos pagam.',
    cards([('Energia jogada fora', '6%', 'de tudo que o país consome num ano', ''),
           ('Daria luz para', '18 mi', 'de casas por um ano inteiro', ''),
           ('Onde dói', '79%', 'no Nordeste', 'ws')])
    + f'<div style="margin-top:16px; height:170px; display:flex; justify-content:center">{MAPA_IMP}</div>', l='0.9', r='1.1'), """
Em 2025 foram seis bilhões e meio de reais perdidos. Energia que daria luz para dezoito milhões de casas por um ano.
E a conta chega na sua casa: a devolução que a lei manda pagar sai do encargo que todos pagamos.
""", 'R$ 6,5 bilhões perdidos em 2025. E a conta chega na sua casa.',
    nota='Caderno do Hackathon IA 2026 / Volt Robotics (R$ 6,5 bi); 35 de 561,6 bilhões de kWh consumidos em 2024 (EPE); casa média de 160 kWh por mês (EPE); Canal Solar (79% no NE); Lei 15.269/2025, paga pelo encargo'))

# 03 · como ajudamos
RESP = [('Vai cortar?', 'Sim', 'chance acima de 95%', 'bad'),
        ('Quanto?', '227 mi de kWh', '1,4 milhão de casas por um mês', ''),
        ('Quando?', 'Dia inteiro', 'pico às 8h', ''),
        ('Por quê?', 'Vento 47% acima', 'do normal', ''),
        ('Onde?', 'Nordeste', 'por região', 'ws')]
CINCO = '<div class="ev" style="margin-top:16px">' + ''.join(
    f'<div class="c{(" " + c) if c else ""}" style="padding:16px 18px"><div class="k">{k}</div><div class="n" style="font-size:34px">{n}</div><p>{p}</p></div>' for k, n, p, c in RESP) + '</div>'
SLIDES.append(slide(f"""
  {eyebrow(3, 'Como ajudamos')}
  <h2 class="claim" style="font-size:42px; margin-top:4px">Avisamos na véspera: <span class="hl">vai cortar, quanto, quando e por quê.</span></h2>
  {CINCO}
  <div class="edai" style="margin-top:16px">O aviso é conselho, não comando: quem decide é o dono da usina.</div>
""", """
Avisamos na véspera: vai cortar, quanto, quando, por quê e onde. Com isso a usina remarca a manutenção para o dia do corte, em vez de perder o dia inteiro.
O aviso é conselho, não comando: quem decide é o dono.
""", 'Avisamos na véspera: vai cortar, quanto, quando e por quê.',
    nota='Máquina do Tempo do WattSteer (wattsteer.com/app), Nordeste, 18/09/2026, previsão da véspera; casa média de 160 kWh por mês (EPE)'))

# 04 · como ganhamos dinheiro, com caso real e alvos
LOGOS7 = ('<div style="margin-top:16px"><div class="k" style="font-size:18px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--t3)">Alvos, ainda não clientes</div>'
          '<div style="display:flex; gap:10px; margin-top:8px">' + ''.join(
    f'<div style="flex:1; height:52px; background:var(--surface); border:1px solid var(--hair); border-radius:12px; display:flex; align-items:center; justify-content:center; padding:8px 12px"><img src="img/logos/{f}" alt="{n}" style="max-height:30px; max-width:100%"></div>'
    for f, n in [('auren-branco.svg', 'Auren'), ('engie.svg', 'Engie'), ('serena.svg', 'Serena'), ('casadosventos.svg', 'Casa dos Ventos'), ('axia.svg', 'Axia'), ('gna.svg', 'GNA')]) + '</div></div>')
SLIDES.append(slide(tela(4, 'Como ganhamos',
    'A usina paga <span class="hl">R$ 5 mil por mês</span>. Uma sozinha perde R$ 529 milhões por ano.',
    'Remarcar a manutenção no dia do corte vale R$ 235 mil por ano.',
    cards([('Auren perdeu', 'R$ 529<small> mi</small>', 'em 2025', 'bad'),
           ('A lei devolve', 'R$ 312<small> mi</small>', 'só até nov/2025', ''),
           ('Ela perde', 'R$ 217<small> mi</small>', 'e ninguém devolve', 'ws')])
    + LOGOS7, l='0.85', r='1.15'), """
A usina paga cinco mil reais por mês. Uma geradora sozinha, a Auren, perdeu quinhentos e vinte e nove milhões com cortes em 2025; a lei devolve trezentos e doze, e os outros duzentos e dezessete ela perde.
Remarcar a manutenção para o dia do corte já vale duzentos e trinta e cinco mil por ano numa usina de cem megawatts.
""", 'A usina paga R$ 5 mil por mês. Uma sozinha perde R$ 529 milhões por ano.',
    nota='Auren, release 4T25 e 2025 (03/03/2026): impacto de R$ 529,5 mi e parcela ressarcível de cerca de R$ 312 mi; valor da manutenção: estimativa da equipe, a medir no piloto; preço a confirmar'))

# 05 · onde estamos
SLIDES.append(slide(tela(5, 'Onde estamos',
    'No ar, prevendo todo dia. Em 328 dias, acertamos a faixa em <span class="hl">83%</span>.',
    'Os dados são públicos. O modelo treinado e o acervo do ONS que montamos, não.',
    cards([('Previmos em 17/09', '227<small> mi de kWh</small>', 'faixa de 148 a 281', ''),
           ('O ONS cortou', '219<small> mi de kWh</small>', 'no dia seguinte', 'bad'),
           ('Erro', '4%', 'meta da faixa: 80%', 'ws')])), """
Está no ar, prevendo todo dia. Em trezentos e vinte e oito dias que o modelo nunca viu, o corte caiu dentro da nossa faixa em oitenta e três por cento das vezes.
Os dados são públicos; o modelo treinado e o acervo do ONS que montamos, não.
""", 'No ar, prevendo todo dia. Em 328 dias, acertamos a faixa em 83%.',
    nota='Máquina do Tempo (wattsteer.com/app): Nordeste, 18/09/2026, previsão da véspera; cobertura medida em 328 dias de uma dobra separada do treino; dados do ONS, da ANEEL e do Open-Meteo'))

# 06 · quem somos
FUND = [('gm.jpg', 'Guilherme Machado', '9 anos no setor elétrico: PSR e Statkraft'),
        ('vt.jpg', 'Vitor Torres', '15 anos em software e dados'),
        ('gc.jpg', 'Guilherme Chaves', '15 anos de software e produtos com IA'),
        ('jv.jpg', 'João Vitor Azevedo', '5 anos em produto: fundou a Urbamob')]
TIME = '<div class="tm4">' + ''.join(
    f'<div class="c tm"><img src="img/fotos/{f}" alt=""><div class="nm">{n}</div><div class="hk">{h}</div></div>' for f, n, h in FUND) + '</div>'
SLIDES.append(slide(tela(6, 'Quem somos',
    'Quatro fundadores. Duas semanas. <span class="hl">Sem captar um centavo.</span>',
    'Mudamos de rota várias vezes. Steer é isso: corrigir o rumo sem parar.',
    TIME, l='0.8', r='1.2'), """
Somos quatro fundadores: setor elétrico, software, inteligência artificial e produto. Fizemos isto em duas semanas, sem captar um centavo.
No caminho mudamos de rota várias vezes. Steer, no nome, é isso: corrigir o rumo sem parar.
""", 'Quatro fundadores. Duas semanas. Sem captar um centavo.',
    nota='Trajetórias escritas por cada fundador; construído de 13 a 27/09/2026'))

# 07 · para onde vamos, pedido e QR
MARCOS = ('<div class="vert">'
          '<div class="c ws"><b>90 dias:</b> piloto com a primeira geradora</div>'
          '<div class="c"><b>12 meses:</b> as primeiras 100 usinas</div>'
          '<div class="c"><b>3 anos:</b> o padrão do país, com baterias</div></div>')
SLIDES.append(slide(f"""
  {eyebrow(7, 'Para onde vamos')}
  <div class="wide" style="height:430px; gap:40px">
    <div class="l" style="flex:1">
      <h2 class="claim">Se em duas semanas fizemos isto, <span class="hl">imaginem em dois anos.</span></h2>
      <div class="edai">Nosso pedido: a primeira geradora.</div>
      <p style="font-size:40px; font-weight:700; margin:22px 0 0">Obrigado.</p>
    </div>
    <div class="r" style="flex:1">{MARCOS}</div>
    <div style="flex:0 0 auto; display:flex; align-items:center; gap:18px"><div id="qr" style="background:#fff; padding:12px; border-radius:16px; line-height:0"></div><div><div class="lbl" style="color:var(--lime)">Veja a solução</div><p style="font-size:24px; font-weight:700; margin:8px 0 0; color:var(--t1)">wattsteer.com/app</p></div></div>
  </div>
""", """
O corte não vai embora: são quase trezentos gigawatts de baterias na fila e corte previsto até 2030.
Se em duas semanas fizemos isto, imaginem em dois anos, com um parceiro do lado. Nosso pedido: a primeira geradora. Obrigado.
""", 'Se em duas semanas fizemos isto, imaginem em dois anos.',
    nota='QR: wattsteer.com/app; LRCAP 2026 com 296,8 GW de baterias cadastrados, 71% no Nordeste (EPE); corte até 2030 (ONS, PEN 2026)'))

# QR da solução no último slide (qrcodejs pelo cdnjs; o legibilidade/shots esperam o render)
QR_JS = ('<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>'
         f'<script>new QRCode(document.getElementById("qr"), {{text: "{SOLUCAO_URL}", width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M}});</script>')
# checkpoint do roteiro: toda fala presente e o total cabe em 3 minutos
for i, s in enumerate(SLIDES, 1):
    assert s['fala'], f'slide {i} sem fala no roteiro'
palavras = [len(s['fala'].split()) for s in SLIDES]
segundos = [round(p * 60 / PALAVRAS_POR_MINUTO) for p in palavras]
total = sum(segundos)
if total > TEMPO_MAXIMO_S:
    raise SystemExit(f'ROTEIRO ACIMA DE 3 MIN: {total} s ({sum(palavras)} palavras). Corte fala antes de gerar.')

# fontes saem do slide (letra pequena não se lê no telão) e vão para o roteiro, embaixo da fala de cada slide
RE_FONTES = re.compile(r'\s*<div class="fontes"><span class="lab">[^<]*</span><div>(.*?)</div></div>', re.S)
for s_ in SLIDES:
    m = RE_FONTES.search(s_['html'])
    s_['fontes'] = ' '.join(re.sub(r'<[^>]+>', '', m.group(1)).split()) if m else ''
    s_['html'] = RE_FONTES.sub('', s_['html'])

body = ''.join('<section class="slide">' + s['html'] + '</section>\n' for s in SLIDES)
OUT.write_text(head + body + QR_JS + '\n</body>\n</html>\n')

linhas = ['# Roteiro do pitch (v36)', '',
          f'Tempo estimado: **{total // 60} min {total % 60:02d} s** ({sum(palavras)} palavras a {PALAVRAS_POR_MINUTO} palavras por minuto). Limite: 3 min.',
          'Gerado junto com os slides (`build_v36.py`): mudou um slide, o roteiro muda junto. Desde a v36 o slide funciona sozinho; a fala complementa, não explica.', '']
for i, (s, seg) in enumerate(zip(SLIDES, segundos), 1):
    linhas += [f'## Slide {i} · {s["titulo"]} ({seg} s)', '', s['fala'], '']
    if s.get('fontes'):
        linhas += [f'*Fontes:* {s["fontes"]}', '']
ROTEIRO.write_text('\n'.join(linhas))
print('ok', OUT, '|', ROTEIRO, f'| {total} s, {sum(palavras)} palavras')
