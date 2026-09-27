"""Pitch v37: estrutura oficial do workshop "Como fazer um killer pitch?" da organização (problema, solução,
como funciona, tração, mercado, modelo de negócio, time, futuro), tela 3840x1080 (CSS 1920x540 a 2x) e roteiro gerado junto.
Checkpoints em docs/pitch/CHECKPOINT-CLAREZA.md. Entrega: .pptx e .mp4 (build_entrega.py), nunca PDF."""
import re
from pathlib import Path

HERE = Path(__file__).parent
V48 = (HERE / 'wattsteer-pitch-v48.html').read_text()
OUT = HERE / 'wattsteer-pitch-2026-v37.html'  # sufixo 2026: os nomes wattsteer-pitch-v36..v48 são do deck do Ideathon
ROTEIRO = HERE / 'roteiro-pitch-2026-v37.md'
PALAVRAS_POR_MINUTO = 150
TEMPO_MAXIMO_S = 180

head, *sections = V48.split('<section class="slide"')
head = head.replace('Pitch Ideathon IA COPPE 2026 (v48)', 'Pitch Hackathon IA COPPE 2026 (v37)')
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


# ---- v36: o slide funciona sozinho (afirmação completa + evidência + "e daí"), ver CHECKPOINT-CLAREZA.md ----
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


# 01 · capa: dinheiro que se vê em 3 segundos + a frase de efeito (Guilherme Machado)
SLIDES.append(slide(f"""
  <div class="wide" style="height:440px; gap:44px; align-items:flex-start">
    <div class="l" style="flex:1.05">
      <div class="brand" style="font-size:44px; gap:18px"><div class="logo" style="width:76px; height:76px; font-size:44px; border-radius:18px">W</div>WattSteer</div>
      <div class="num" style="font-size:112px; margin-top:10px">R$ 6,5<small> bi</small></div>
      <p style="font-size:28px; font-weight:700; margin:4px 0 0">de prejuízo das usinas de vento e sol em 2025.</p>
      <p style="font-size:24px; font-weight:600; margin:8px 0 0; color:var(--grapel); line-height:1.3">Quando a rede não aguenta, o ONS manda parar: é o corte. Triplicou num ano.</p>
      <p style="font-size:24px; font-weight:600; margin:12px 0 0; color:var(--t1); line-height:1.3">O WattSteer avisa um dia antes do corte. <b style="color:var(--lime)">A usina paga pelo aviso.</b></p>
    </div>
    <div class="card hi" style="flex:0.55; padding:30px 30px; border-width:2px; border-color:var(--lime); margin-top:60px">
      <div class="num" style="font-size:70px">R$ 4,4<small> bi</small></div>
      <p style="font-size:26px !important; color:var(--t1) !important; margin-top:12px">que a Lei 15.269 devolve. Mais de R$ 2 bi ninguém devolve.</p>
    </div>
    <div class="r" style="flex:0.6; height:440px; display:flex; justify-content:center"><div style="position:relative; width:400px; height:410px; margin-top:10px">{MAPA_CAPA}<div class="maptag" style="font-size:18px; width:auto; white-space:nowrap; right:auto; left:52%; top:26%">Nordeste: 79% do corte</div></div></div>
  </div>
  {fontes('R$ 6,5 bi: perdas dos geradores eólicos e solares com cortes em 2025, Caderno do Hackathon IA 2026 / Volt Robotics · quase triplicou: 12,7 para 35 bilhões de kWh de 2024 para 2025 (ONS, RT DGL 0189/2025; Volt Robotics) · até R$ 4,4 bi: devolução dos cortes de set/2023 a nov/2025, Lei 15.269/2025 (estimativas de R$ 2,7 a 4,4 bi: MME; Volt Robotics; Canal Solar) · mapa: Felipe Menegaz, Wikimedia Commons, CC BY-SA 3.0')}
""", """
Em 2025, as usinas de vento e sol do Brasil perderam seis bilhões e meio de reais com cortes, e o corte quase triplicou em um ano.
Nós somos o WattSteer. Vendemos previsão que vira receita para quem gera energia. E o corte é só o começo.
""", 'R$ 6,5 bi de prejuízo em 2025; até R$ 4,4 bi a recuperar.', nota='Caderno do Hackathon IA 2026 / Volt Robotics (R$ 6,5 bi); ONS, RT DGL 0189/2025 (12,7 para 35 bilhões de kWh); Lei 15.269/2025, MME e Volt (R$ 2,7 a 4,4 bi a recuperar)'))

# 02 · problema: a rede não aguenta, cresce até 2030, e quem paga a conta é o consumidor (João Vitor, impacto social)
GRAF = """<div class="chart" style="padding:14px 24px"><div class="ttl">Bilhões de kWh jogados fora</div>
    <svg viewBox="0 0 1000 300" width="100%" height="300" style="margin-top:4px">
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
SLIDES.append(slide(tela(2, 'Problema',
    'Energia limpa <span class="hlg">jogada fora</span>: 35 bilhões de kWh, 6% de tudo que o Brasil consome num ano.',
    'O corte encarece a conta de luz: o consumidor paga a devolução. Não dá para evitá-lo; dá para perder menos.',
    GRAF + '<p style="font-size:22px; color:var(--t2); margin:12px 0 0">Dá luz para <b style="color:var(--t1)">18 milhões de casas</b> por um ano. <b style="color:var(--t1)">79% no Nordeste</b>, e o ONS prevê corte até 2030.</p>',
    )
    + fontes('<b>ONS</b>, RT DGL 0189/2025 (46, 389 e 1.447 MW médios em 2022-2024) · Caderno do Hackathon IA 2026 / Volt Robotics (4.021 MW médios em 2025, cerca de 20% da geração eólica e solar) · 79%: Canal Solar sobre dados do <b>ONS</b> (jan-abr/2026) · até 2030: <b>ONS</b>, PEN 2026, cap. 4 (corte médio de 2 a 3 GW em toda safra de ventos) · quem paga: compensação da Lei 15.269/2025 custeada pelo ESS (Encargo de Serviços do Sistema), R$ 2,7 a 3,3 bi (<b>MME</b>) e cerca de R$ 3 bi (<b>ANEEL</b>, jan/2026) · R$ 65 mi = 1% de R$ 6,5 bi'), """
Quando os fios não dão conta, o ONS desliga usinas de vento e sol: um de cada cinco kWh em 2025, oitenta por cento no Nordeste.
E o corte continua até 2030. O custo do corte aumenta a conta de luz: a devolução sai de um encargo que todos pagam, e a térmica ligada no lugar custa mais.
""", 'Energia limpa jogada fora: 35 bilhões de kWh em 2025, um ano de luz para 18 milhões de casas.', nota='ONS RT DGL 0189/2025 e Volt Robotics (cortes); 6% = 35 de 561,6 bilhões de kWh consumidos no país em 2024 (EPE, Anuário 2025); 18 milhões de casas a 160 kWh por mês (EPE); Canal Solar (79% no NE); ONS PEN 2026; Lei 15.269/2025, pago no encargo'))

# 03 · o cliente e a dor dele, com nome e fonte (Guilherme Machado)
SLIDES.append(slide(tela(3, 'A dor',
    'Quem gera investiu <span class="hl">bilhões</span> e perde <span class="hlg">centenas de milhões</span> quando o ONS corta.',
    'E a devolução some: 2 em cada 3 cortes já não são devolvidos. Em 2029, 96%.',
    cards([('Gerou em 2025', '15%<small> a menos</small>', 'do que podia', ''),
           ('Perdeu com cortes', 'R$ 529<small> mi</small>', '', 'bad'),
           ('A usina perde', 'R$ 217<small> mi</small>', 'e ninguém devolve', 'ws')])
    + '<p style="font-size:22px; color:var(--t2); margin:14px 0 0">Exemplo real: <b style="color:var(--t1)">Auren Energia</b>.</p>')
    + fontes('<b>Auren</b>, release de resultados 4T25 e 2025 (03/03/2026), pp. 4-6: impacto do curtailment de R$ 529,5 mi (R$ 451,8 mi eólica, R$ 77,6 mi solar), geração de 1.242 MW médios contra potencial de 1.469; parcela ressarcível pela Lei 15.269/2025 estimada pela empresa em cerca de R$ 312 mi · Ventos do Piauí II e III: 409,2 MW por R$ 2,1 bi (CanalEnergia, 2025) · comparação: <b>Serena</b> perdeu R$ 39,7 mi só no 1T25 e recebeu R$ 9,8 mi (CanalEnergia; MegaWhat)'), """
A Auren gerou quinze por cento a menos do que podia e perdeu quinhentos e vinte e nove milhões; a lei devolve trezentos e doze.
E a devolução está acabando: dois em cada três cortes já não são devolvidos.
""", 'Nosso cliente investiu bilhões para gerar e perde centenas de milhões quando o ONS corta.', nota='Auren, release 4T25 e 2025 (03/03/2026): geração potencial de 1.469 MW médios contra 1.242 gerados, impacto de R$ 529,5 mi e parcela ressarcível de cerca de R$ 312 mi; corte por sobra de energia, sem direito a devolução: 67% em 2026 (ONS via Volt Robotics) e projeção de 96% em 2029 (ONS, RT DGL 0189/2025)'))

# 04 · solução: quatro serviços, todos viram receita (Guilherme Machado: bateria e "maximizar a receita")
SLIDES.append(slide(tela(4, 'Solução',
    'Hoje entregamos uma coisa: <span class="hl">o aviso da véspera</span>, com quanto, quando e por quê.',
    'Com ele a usina já programa a parada. As outras duas ainda vamos construir.',
    passos([('No ar: o aviso da véspera', 'quanto, quando e por quê'),
            ('Falta fazer: puxar a manutenção para o dia do corte', ''),
            ('Falta fazer: guardar a prova do corte para o ressarcimento', '')], destaque=1), l='0.85', r='1.15')
    + fontes('Recuperação: a CCEE recontabiliza pela REN ANEEL 1.109/2024 e entrega pela plataforma DRI; nós conferimos parque a parque, meia hora a meia hora, e contestamos a classificação do corte · Lei 15.269/2025 e <b>MME</b> Portaria 140/2026 (cortes de set/2023 a nov/2025) · bateria: LRCAP 2026 com 296,8 GW cadastrados, 71% no NE (<b>EPE</b>, 03/08/2026; Canal Solar)'), """
Hoje entregamos uma coisa: o aviso da véspera, com quanto, quando e por quê. Quem é cortado paga a diferença ao preço da hora, e essa conta chega um mês depois.
Manutenção na janela e prova para o ressarcimento ainda vamos construir.
""", 'Hoje entregamos uma coisa: o aviso da véspera.', nota='Exposição do gerador cortado liquidada ao preço horário (PLD) na contabilização mensal da CCEE; Lei 15.269/2025 e MME Portaria 140/2026 (devolução de cortes de set/2023 a nov/2025)'))

# 05 · como funciona: as cinco respostas em português, sem sigla (Guilherme, 26/09 22:39: a banca tem cinco perfis; a tela real fica para a demo)
RESP = [('Vai cortar?', 'Sim', 'chance acima de 95%', 'bad'),
        ('Quanto?', '227 milhões de kWh', '1,4 milhão de casas por um mês', ''),
        ('Quando?', 'Dia inteiro', '', ''),
        ('Por quê?', 'Vento 47% acima do normal', '', ''),
        ('Onde?', 'Nordeste', 'por região', 'ws')]
CINCO = '<div class="ev" style="margin-top:16px">' + ''.join(
    f'<div class="c{(" " + c) if c else ""}" style="padding:16px 18px"><div class="k">{k}</div><div class="n" style="font-size:38px">{n}</div><p>{p}</p></div>' for k, n, p, c in RESP) + '</div>'
SLIDES.append(slide(f"""
  {eyebrow(5, 'Como funciona')}
  <h2 class="claim" style="font-size:40px; margin-top:4px">Na véspera, <span class="hl">cinco respostas</span> para a região. Nordeste, 18/09:</h2>
  {CINCO}
  <div class="edai" style="margin-top:16px">O aviso é conselho, não comando: quem decide é o dono. Publicamos o placar de acertos e erros de cada dia.</div>
""", """
Na véspera, o dono abre o WattSteer e vê cinco respostas: vai cortar, quanto, quando, por quê e onde.
Tem dúvida? Pergunta por texto ou voz. A IA comunica, os modelos calculam, o dono decide.
""", 'Na véspera, cinco respostas: vai cortar, quanto, quando, por quê e onde.', nota='Máquina do Tempo (wattsteer.com/app), Nordeste, 18/09/2026, previsão da véspera; motivo apontado pelo modelo: vento 47% acima do esperado; casa média de 160 kWh por mês (EPE)'))

# 06 · o vídeo: demonstração gravada do produto (Guilherme, 27/09: "precisa de um slide pra botarmos nosso vídeo")
QUADRO = """
  <div style="display:flex; justify-content:center">
    <div class="shot" style="position:relative; display:inline-block">
      <img src="img/reel-poster.jpg" alt="Tela do WattSteer: mapa do corte previsto por região" style="height:404px; width:auto">
      <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center">
        <div style="width:92px; height:92px; border-radius:999px; background:var(--lime); display:flex; align-items:center; justify-content:center; box-shadow:0 10px 40px rgba(0,0,0,.45)">
          <svg viewBox="0 0 24 24" width="42" height="42"><path d="M8 5v14l11-7z" fill="#1E2B10"/></svg>
        </div>
      </div>
      <div style="position:absolute; left:0; right:0; bottom:0; padding:10px 16px; font-size:19px; font-weight:700; color:#fff; background:linear-gradient(transparent, rgba(0,0,0,.85))">Demonstração gravada · 50 s</div>
    </div>
  </div>"""
VISTO = passos([('O mapa do dia: onde e quanto', ''), ('O porquê, em português', ''), ('A Máquina do Tempo: acerto medido', '')])
SLIDES.append(slide(tela(6, 'Demonstração',
    'Não é maquete: <span class="hl">é o produto no ar</span>, rodando com dado do ONS.',
    'O mesmo que a usina vê na véspera.' + VISTO,
    QUADRO, l='0.9', r='1.1')
    + fontes('Gravação de tela do WattSteer (' + SOLUCAO_URL + '), 26/09/2026: mapa do dia por região, explicação do motivo e Máquina do Tempo (acerto medido em 328 dias liquidados)'), """
Em cinquenta segundos, o produto no ar.
""", 'Não é maquete: é o produto no ar.', nota='Gravação de tela do WattSteer em 26/09/2026; os números da tela vêm do acervo do ONS que montamos'))

# 07 · tração: duas semanas, no ar, só com dados públicos (João Vitor: linha do tempo; Vitor: dados públicos)
LINHA = ('<div class="tline big" style="grid-template-columns:repeat(3,1fr)">'
         '<div class="tnode"><div class="d"></div><div class="w">Ideathon</div><p>Só a ideia</p></div>'
         '<div class="tnode hl"><div class="d"></div><div class="w">Hoje</div><p>No ar</p></div>'
         '<div class="tnode"><div class="d"></div><div class="w">Próximo</div><p>Piloto</p></div></div>')
# o que existe de fato (Guilherme, 27/09: a comparação precisa ser justa com o que foi construído)
RECURSOS = ('<div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:20px">' + ''.join(
    f'<span class="pill" style="font-size:20px; padding:9px 16px">{t}</span>' for t in [
        'Modelo próprio, treinado', 'Aplicativo na web', 'Acervo próprio do ONS',
        'Coleta automática', 'Histórico desde o primeiro dia', 'Infraestrutura que cresce']) + '</div>')
SLIDES.append(slide(tela(7, 'Onde estamos',
    'Duas semanas, quatro fundadores, <span class="hl">sem captar um centavo</span>. Tudo isto já está no ar.',
    'O dado é público. O modelo treinado e o acervo do ONS que montamos, não.',
    LINHA + RECURSOS)
    + fontes('Stack na AWS do evento (wattsteer.com) · técnica: LightGBM hurdle com intervalos conformalizados (P10/P50/P90), SHAP com regras do ONS (REL/CNF/ENE), RAG sobre documentos do ONS com resposta por texto ou áudio, Replay temporal, guardrails · <b>ONS</b> Dados Abertos (constrained-off, balanço por subsistema, carga, intercâmbio, DESSEM) · <b>ANEEL</b> SIGA · Open-Meteo'), """
Em duas semanas, quatro pessoas, sem captar um centavo. O dado é público; o modelo treinado, o acervo do ONS que montamos e o histórico casado todo dia, não.
""", 'Duas semanas, quatro fundadores, sem investimento. Tudo isto já está no ar.', nota='Construído de 13 a 27/09/2026, com dados do ONS, da ANEEL e do Open-Meteo, programas de código aberto e nuvem AWS do evento'))

# 08 · a prova: previsão x realidade, com números reais da Máquina do Tempo (Vitor; Guilherme)
SLIDES.append(slide(tela(8, 'A prova',
    'Em <span class="hl">328 dias que o modelo não viu</span>, o corte caiu dentro da nossa faixa em 83%.',
    'Em 18/09, dissemos entre 148 e 281 milhões; o ONS cortou 219. O valor central errou 4%.',
    cards([('Véspera, 17/09', '227<small> milhões</small>', 'faixa: 148 a 281', ''),
           ('Dia 18/09', '219<small> milhões</small>', 'o ONS cortou', 'bad'),
           ('Erro', 'abaixo de 4%', '3 das 4 regiões na faixa', 'ws')]),
    )
    + fontes('Máquina do Tempo do WattSteer (' + SOLUCAO_URL + '/time-machine): Nordeste, 18/09/2026, previsão da véspera às 9h (rodada 00Z) contra o liquidado pelo ONS; modelo F6 treinado só até 30/06/2026, sem nenhuma informação futura; P10-P90 de 93 a 220 mil MWh na véspera anterior; cobertura de 83% em 328 dias liquidados (meta 80%)'), """
E nós provamos. A Máquina do Tempo testa num dia que o modelo nunca viu, só com o que se sabia na véspera.
Em trezentos e vinte e oito dias que o modelo não viu, o corte caiu dentro da nossa faixa em oitenta e três por cento. A meta era oitenta.
""", 'Em 328 dias que o modelo não viu, o corte caiu dentro da nossa faixa em 83%.', nota='Máquina do Tempo (wattsteer.com/app): faixa de 148 a 281 milhões de kWh (P10 a P90) na véspera de 18/09/2026; valor central 227; cobertura medida em 328 dias de uma dobra separada do treino'))

# 09 · mercado: TAM, SAM, SOM com a conta (Guilherme Machado)
def mcard(sigla, valor, conta, hi=False):
    return (f'<div class="card{" hi" if hi else ""}" style="flex:1; padding:18px 22px"><div class="lbl"{" style=\"color:var(--lime)\"" if hi else ""}>{sigla}</div>'
            f'<div class="num" style="font-size:50px; margin-top:8px">{valor}</div><p style="margin-top:6px">{conta}</p></div>')
SLIDES.append(slide(tela(9, 'Mercado',
    'Preço: <span class="hl">R$ 5 mil por mês</span>. Quanto o aviso economiza é o que o piloto vai medir.',
    'Automatizar isso é o próximo passo.',
    cards([('Hoje, com o aviso', 'remarcar à mão', 'a manutenção para o dia do corte', ''),
           ('Vale', 'R$ 235<small> mil/ano</small>', 'numa usina de 100 MW', ''),
           ('Preço', 'R$ 60<small> mil/ano</small>', 'a confirmar', 'ws')])
    + '<p style="font-size:24px; color:var(--t2); margin:14px 0 0">Com 113 assinantes, <b style="color:var(--lime)">R$ 565 mil por mês</b>.</p>',
    )
    + fontes('Valor por usina: estimativa da equipe (Guilherme Machado, 26/09), cenário-base com dados de <b>EPE</b>, <b>ONS</b>, <b>ANEEL</b> e IBGE: manutenção flexível programada nas janelas de corte (R$ 235 mil/ano por 100 MW; R$ 90 mi/ano no Brasil) e compra antecipada da energia de reposição (vantagem histórica de R$ 8 a 14/MWh; R$ 250 a 400 mil/ano por ativo com corte alto); não é resultado observado · <b>BNB</b>/ETENE, Caderno Setorial 415 (1.132 usinas eólicas no Brasil, 1.026 no NE, set/2025) · R$ 60 mil/ano = R$ 5 mil/mês (hipótese); R$ 68 mi = 1.132 x R$ 60 mil · comissão: 10 a 20% de R$ 2,7 a 4,4 bi (<b>MME</b>; Volt Robotics; Canal Solar)'), """
Cobramos cinco mil por mês. Com o aviso, a usina já remarca a manutenção para o dia do corte: numa usina de cem megawatts, duzentos e trinta e cinco mil por ano.
""", 'Preço: R$ 5 mil por mês. O que o aviso economiza, o piloto vai medir.', nota='Valor por usina: estimativa da equipe, cenário-base (EPE, ONS, ANEEL, IBGE); BNB/ETENE, Caderno Setorial 415 (1.132 usinas eólicas, set/2025); solar de grande porte acima de 20 GW, 52% no Nordeste (ABSOLAR, jan/2026); preço: hipótese a validar no piloto'))

# 10 · time (penúltimo): o que cada um já construiu
FUND = [('gm.jpg', 'Guilherme Machado', '9 anos no setor elétrico: planejamento na PSR e comercializadora na Statkraft', 9),
        ('vt.jpg', 'Vitor Torres', '15 anos em software e dados: plataformas e dados em produção', 15),
        ('gc.jpg', 'Guilherme Chaves', '15 anos de software: produtos de ponta a ponta com IA', 15),
        ('jv.jpg', 'João Vitor Azevedo', '5 anos em produto: fundou a Urbamob', 5)]
CARDS = ''.join(f'<div class="c tm"><img src="img/fotos/{f}" alt=""><div class="nm">{n}</div><div class="hk">{h}</div></div>' for f, n, h, _ in FUND)
CORES = ['#5B6828', '#8FA83A', '#D0F244', '#EEF8C0']
BARRA = ''.join(f'<div style="flex:{a}; background:{c}; color:{"#fff" if i == 0 else "#1E2B10"}; font-size:18px; font-weight:700; text-align:center; line-height:30px">{a}</div>'
                for i, ((_, _, _, a), c) in enumerate(zip(FUND, CORES)))
TIME = (f'<div class="tm4">{CARDS}</div>'
        '<div style="display:flex; align-items:baseline; gap:14px; margin-top:14px"><div class="num" style="font-size:40px">44+ anos</div><div style="font-size:22px; color:var(--t2)">de experiência somados</div></div>'
        f'<div style="display:flex; height:30px; border-radius:8px; overflow:hidden; margin-top:8px; gap:3px">{BARRA}</div>')
SLIDES.append(slide(tela(10, 'Time',
    'Quatro fundadores: setor elétrico, software, IA e produto. <span class="hl">Construímos isto em duas semanas.</span>',
    'Mudamos de rota várias vezes em duas semanas. <b>Steer é isso: corrigir o rumo sem parar.</b>',
    TIME, l='0.8', r='1.2')
    + fontes('Trajetórias: bios escritas por cada fundador'), """
Quatro fundadores: setor elétrico, software, IA e produto.
Em duas semanas mudamos de rota várias vezes. Steer é isso: corrigir o rumo sem parar.
""", 'Quatro fundadores. Construímos isto em duas semanas.', nota='Trajetórias escritas por cada fundador'))

# 11 · futuro: verticais (Guilherme Machado), pedido, obrigado e QR
LOGOS = ('<div style="margin-top:12px"><div class="k" style="font-size:18.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--t3)">Alvos, ainda não clientes</div>'
         '<div style="display:flex; gap:10px; margin-top:8px">' + ''.join(
    f'<div style="flex:1; height:48px; background:var(--surface); border:1px solid var(--hair); border-radius:12px; display:flex; align-items:center; justify-content:center; padding:8px 12px"><img src="img/logos/{f}" alt="{n}" style="max-height:30px; max-width:100%"></div>'
    for f, n in [('auren-branco.svg', 'Auren'), ('engie.svg', 'Engie'), ('serena.svg', 'Serena'), ('casadosventos.svg', 'Casa dos Ventos'), ('axia.svg', 'Eletrobras Axia'), ('gna.svg', 'GNA')]) + '</div></div>')
VERT = ('<div class="vert">'
        '<div class="c ws"><b>90 dias:</b> o piloto</div>'
        '<div class="c"><b>12 meses:</b> 100 usinas</div>'
        '<div class="c"><b>3 anos:</b> padrão do país</div>'
        '<div class="c" style="background:var(--limecard); border-color:var(--limeline)"><b>A onda vem:</b> 296 GW de baterias na fila</div></div>')
DEVOLVE = ('<div style="margin-top:12px"><div class="k" style="font-size:18.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--lime)">Devolvemos</div>'
           '<div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px">' + ''.join(
    f'<span class="pill" style="font-size:18px; padding:8px 14px">{t}</span>' for t in [
        'Acervo do ONS aberto', 'Placar de acerto público', 'Grátis para pesquisa']) + '</div></div>')
SLIDES.append(slide(f"""
  {eyebrow(11, 'Futuro')}
  <div class="wide" style="height:430px; gap:40px">
    <div class="l" style="flex:1">
      <h2 class="claim" style="font-size:42px; margin-top:16px">Nascemos do dado aberto do ONS, no Rio. <span class="hl">E devolvemos.</span></h2>
      <div class="edai">Nosso pedido: uma geradora e a COPPE para auditar o método.</div>
      {DEVOLVE}<p style="font-size:30px; font-weight:700; margin:12px 0 0">Obrigado.</p>
    </div>
    <div class="r" style="flex:1">{VERT}{LOGOS}</div>
    <div style="flex:0 0 auto; display:flex; align-items:center; gap:18px"><div id="qr" style="background:#fff; padding:12px; border-radius:16px; line-height:0"></div><div><div class="lbl" style="color:var(--lime)">A solução</div><p style="font-size:24px; font-weight:700; margin:8px 0 0; color:var(--t1)">wattsteer.com/app</p></div></div>
  </div>
  {fontes('QR: ' + SOLUCAO_URL)}
""", """
Nascemos do dado aberto do ONS e devolvemos: acervo aberto e placar de acerto público.
Em noventa dias, o piloto; em um ano, cem usinas; em três anos, o padrão do país, com baterias.
Se em duas semanas fizemos isto, imaginem em dois anos. Vocês viram um produto; o que construímos foi um time que não para.
Nosso pedido: uma geradora e um laboratório da COPPE para auditar o método. Obrigado.
""", 'Nascemos do dado aberto do ONS, no Rio. E devolvemos.', nota='QR: wattsteer.com/app; marcos, devolução ao ecossistema e alvos: compromissos e plano da equipe; LRCAP 2026 com 6.091 projetos de bateria e 296,8 GW cadastrados, 71% no Nordeste (EPE, 03/08/2026); corte até 2030 (ONS, PEN 2026)'))


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

linhas = ['# Roteiro do pitch (v37)', '',
          f'Tempo estimado: **{total // 60} min {total % 60:02d} s** ({sum(palavras)} palavras a {PALAVRAS_POR_MINUTO} palavras por minuto). Limite: 3 min.',
          'Gerado junto com os slides (`build_2026_v37.py`): mudou um slide, o roteiro muda junto. Desde a v36 o slide funciona sozinho; a fala complementa, não explica.', '']
for i, (s, seg) in enumerate(zip(SLIDES, segundos), 1):
    linhas += [f'## Slide {i} · {s["titulo"]} ({seg} s)', '', s['fala'], '']
    if s.get('fontes'):
        linhas += [f'*Fontes:* {s["fontes"]}', '']
ROTEIRO.write_text('\n'.join(linhas))
print('ok', OUT, '|', ROTEIRO, f'| {total} s, {sum(palavras)} palavras')
