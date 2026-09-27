"""Gera a entrega do pitch no formato da tela do evento (3840x1080, 32:9): .pptx e .mp4. Nunca PDF.

Uso: python3 build_entrega.py <pasta_com_s01.png...> <roteiro-pitch-final-vN.md> <saida_sem_extensao>
- .pptx: um slide por imagem, em tela cheia, montado só com a biblioteca padrão (zip de XML).
- .mp4: cada slide fica na tela pelo tempo da sua fala no roteiro (ffmpeg).
Os PNGs saem de scratchpad/deck/shots_wide.py (CSS 1920x540 renderizado a 2x).
"""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile

# 32:9 em EMU (o 16:9 padrão é 12192000 x 6858000)
CX, CY = 24384000, 6858000

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
{slides}
</Types>'''

ROOT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>'''

CORE = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>WattSteer · Pitch final</dc:title><dc:creator>WattSteer</dc:creator></cp:coreProperties>'''

APP = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>WattSteer build_entrega.py</Application></Properties>'''

PRESENTATION = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>{ids}</p:sldIdLst>
<p:sldSz cx="{cx}" cy="{cy}"/><p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>'''

PRES_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
{slides}
</Relationships>'''

EMPTY_TREE = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>'

MASTER = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
{EMPTY_TREE}
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>'''

MASTER_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>'''

LAYOUT = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
{EMPTY_TREE}
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>'''

LAYOUT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>'''

THEME = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="WattSteer"><a:themeElements>
<a:clrScheme name="WattSteer"><a:dk1><a:srgbClr val="131316"/></a:dk1><a:lt1><a:srgbClr val="F7F7F7"/></a:lt1><a:dk2><a:srgbClr val="1B1B1F"/></a:dk2><a:lt2><a:srgbClr val="A2A2AC"/></a:lt2>
<a:accent1><a:srgbClr val="D0F244"/></a:accent1><a:accent2><a:srgbClr val="8D5DF6"/></a:accent2><a:accent3><a:srgbClr val="EDA23F"/></a:accent3><a:accent4><a:srgbClr val="5B6828"/></a:accent4><a:accent5><a:srgbClr val="543C8A"/></a:accent5><a:accent6><a:srgbClr val="2D5A57"/></a:accent6>
<a:hlink><a:srgbClr val="D0F244"/></a:hlink><a:folHlink><a:srgbClr val="B79BFF"/></a:folHlink></a:clrScheme>
<a:fontScheme name="WattSteer"><a:majorFont><a:latin typeface="Poppins"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Poppins"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="WattSteer">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements></a:theme>'''

SLIDE = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:pic><p:nvPicPr><p:cNvPr id="2" name="Slide {n}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>'''

SLIDE_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image{n}.png"/>
</Relationships>'''


def pptx(pngs, saida):
    n = len(pngs)
    with zipfile.ZipFile(saida, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES.format(slides='\n'.join(
            f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' for i in range(1, n + 1))))
        z.writestr('_rels/.rels', ROOT_RELS)
        z.writestr('docProps/core.xml', CORE)
        z.writestr('docProps/app.xml', APP)
        z.writestr('ppt/presentation.xml', PRESENTATION.format(cx=CX, cy=CY, ids=''.join(f'<p:sldId id="{255 + i}" r:id="rId{2 + i}"/>' for i in range(1, n + 1))))
        z.writestr('ppt/_rels/presentation.xml.rels', PRES_RELS.format(slides='\n'.join(
            f'<Relationship Id="rId{2 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>' for i in range(1, n + 1))))
        z.writestr('ppt/slideMasters/slideMaster1.xml', MASTER)
        z.writestr('ppt/slideMasters/_rels/slideMaster1.xml.rels', MASTER_RELS)
        z.writestr('ppt/slideLayouts/slideLayout1.xml', LAYOUT)
        z.writestr('ppt/slideLayouts/_rels/slideLayout1.xml.rels', LAYOUT_RELS)
        z.writestr('ppt/theme/theme1.xml', THEME)
        for i, png in enumerate(pngs, 1):
            z.writestr(f'ppt/slides/slide{i}.xml', SLIDE.format(n=i, cx=CX, cy=CY))
            z.writestr(f'ppt/slides/_rels/slide{i}.xml.rels', SLIDE_RELS.format(n=i))
            z.write(png, f'ppt/media/image{i}.png')


def mp4(pngs, segundos, saida):
    """Cada slide fica na tela pelo tempo da fala dele (concat do ffmpeg)."""
    with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
        for png, s in zip(pngs, segundos):
            f.write(f"file '{os.path.abspath(png)}'\nduration {s}\n")
        f.write(f"file '{os.path.abspath(pngs[-1])}'\n")  # o concat só respeita a duração do último se ele se repetir
        lista = f.name
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lista,
                    '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-t', str(sum(segundos)), saida], check=True)  # -t corta a repetição do último
    os.unlink(lista)


# ---------------------------------------------------------------- motion
# Com camadas (scratchpad/deck/layers.py), cada elemento entra sozinho, em sequência curta:
# títulos sobem de leve, cards entram em cascata, números fazem zoom sutil, o gráfico cresce de baixo para cima.
EMU = CX // 3840  # 6350 EMU por pixel da tela de 3840x1080
DUR = {'fade': 900, 'float': 650, 'slide': 550, 'zoom': 700, 'pop': 450, 'wipe_up': 1000, 'wipe_right': 900}
INICIO_MS, CASCATA_MS, PASSO_MS = 300, 130, 280


def agenda(camadas):
    """Início (ms) de cada camada: mesma família em cascata curta, troca de família com respiro."""
    t, out = INICIO_MS, []
    for i, c in enumerate(camadas):
        out.append(t)
        prox = camadas[i + 1]['fx'] if i + 1 < len(camadas) else None
        t += CASCATA_MS if prox == c['fx'] else PASSO_MS
    return out


def _set(cid, spid):
    return (f'<p:set><p:cBhvr><p:cTn id="{cid}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>'
            f'<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>'
            '<p:to><p:strVal val="visible"/></p:to></p:set>')


def _efeito(cid, spid, dur, filtro):
    return (f'<p:animEffect transition="in" filter="{filtro}"><p:cBhvr><p:cTn id="{cid}" dur="{dur}"/>'
            f'<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>')


def _move(cid, spid, dur, attr, de):
    """Anima uma propriedade de de -> atual, com desaceleração no fim (ease-out)."""
    return (f'<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="{cid}" dur="{dur}" decel="100000" fill="hold"/>'
            f'<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl><p:attrNameLst><p:attrName>{attr}</p:attrName></p:attrNameLst></p:cBhvr>'
            f'<p:tavLst><p:tav tm="0"><p:val><p:strVal val="{de}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#{attr}"/></p:val></p:tav></p:tavLst></p:anim>')


def timing(camadas, spids):
    """XML <p:timing>: tudo entra sozinho ao abrir o slide (sem clique), na ordem da agenda."""
    cid = [4]

    def nid():
        cid[0] += 1
        return cid[0]
    pars = []
    for k, (c, spid, ini) in enumerate(zip(camadas, spids, agenda(camadas))):
        fx, dur = c['fx'], DUR[c['fx']]
        preset = {'fade': 10, 'float': 42, 'slide': 42, 'zoom': 53, 'pop': 53, 'wipe_up': 22, 'wipe_right': 22}[fx]
        sub = {'wipe_up': 4, 'wipe_right': 8}.get(fx, 0)
        ef = nid()
        corpo = _set(nid(), spid)
        if fx.startswith('wipe'):
            corpo += _efeito(nid(), spid, dur, 'wipe(up)' if fx == 'wipe_up' else 'wipe(right)')
        else:
            corpo += _efeito(nid(), spid, dur, 'fade')
            if fx == 'float':
                corpo += _move(nid(), spid, dur, 'ppt_y', '#ppt_y+0.025')
            elif fx == 'slide':
                corpo += _move(nid(), spid, dur, 'ppt_x', '#ppt_x+0.012')
            elif fx in ('zoom', 'pop'):
                f = '0.9' if fx == 'zoom' else '0.8'
                corpo += _move(nid(), spid, dur, 'ppt_w', f'#ppt_w*{f}') + _move(nid(), spid, dur, 'ppt_h', f'#ppt_h*{f}')
        tipo = 'afterEffect' if k == 0 else 'withEffect'
        pars.append(f'<p:par><p:cTn id="{ef}" presetID="{preset}" presetClass="entr" presetSubtype="{sub}" fill="hold" grpId="0" nodeType="{tipo}">'
                    f'<p:stCondLst><p:cond delay="{ini}"/></p:stCondLst><p:childTnLst>{corpo}</p:childTnLst></p:cTn></p:par>')
    return ('<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
            '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
            '<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst>'
            '<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
            + ''.join(pars) +
            '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>'
            '</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
            '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>'
            '</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>')


def _pic(spid, nome, rid, x, y, w, h):
    return (f'<p:pic><p:nvPicPr><p:cNvPr id="{spid}" name="{nome}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
            f'<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
            f'<p:spPr><a:xfrm><a:off x="{x * EMU}" y="{y * EMU}"/><a:ext cx="{w * EMU}" cy="{h * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>')


def pptx_animado(pasta, manifest, saida):
    n = len(manifest)
    with zipfile.ZipFile(saida, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES.format(slides='\n'.join(
            f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' for i in range(1, n + 1))))
        z.writestr('_rels/.rels', ROOT_RELS)
        z.writestr('docProps/core.xml', CORE)
        z.writestr('docProps/app.xml', APP)
        z.writestr('ppt/presentation.xml', PRESENTATION.format(cx=CX, cy=CY, ids=''.join(f'<p:sldId id="{255 + i}" r:id="rId{2 + i}"/>' for i in range(1, n + 1))))
        z.writestr('ppt/_rels/presentation.xml.rels', PRES_RELS.format(slides='\n'.join(
            f'<Relationship Id="rId{2 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>' for i in range(1, n + 1))))
        z.writestr('ppt/slideMasters/slideMaster1.xml', MASTER)
        z.writestr('ppt/slideMasters/_rels/slideMaster1.xml.rels', MASTER_RELS)
        z.writestr('ppt/slideLayouts/slideLayout1.xml', LAYOUT)
        z.writestr('ppt/slideLayouts/_rels/slideLayout1.xml.rels', LAYOUT_RELS)
        z.writestr('ppt/theme/theme1.xml', THEME)
        for i, sl in enumerate(manifest, 1):
            rels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>']
            pics, spids = [], []
            for j, (png, x, y, w, h) in enumerate([(sl['bg'], 0, 0, 3840, 1080)] + [(c['png'], c['x'], c['y'], c['w'], c['h']) for c in sl['camadas']]):
                rid, spid = f'rId{j + 2}', j + 2
                rels.append(f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/{png}"/>')
                pics.append(_pic(spid, png, rid, x, y, w, h))
                if j:
                    spids.append(spid)
                z.write(os.path.join(pasta, png), f'ppt/media/{png}')
            xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
                   '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
                   + ''.join(pics) + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
                   '<p:transition spd="slow"><p:fade/></p:transition>'
                   + (timing(sl['camadas'], spids) if sl['camadas'] else '') + '</p:sld>')
            z.writestr(f'ppt/slides/slide{i}.xml', xml)
            z.writestr(f'ppt/slides/_rels/slide{i}.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                       '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(rels) + '</Relationships>')


def mp4_animado(pasta, manifest, segundos, saida):
    """Mesmo movimento do .pptx no vídeo: cada camada entra com fade e um deslocamento curto, e o slide abre com fade."""
    partes = []
    tmp = tempfile.mkdtemp()
    for i, (sl, seg) in enumerate(zip(manifest, segundos)):
        ins = ['-loop', '1', '-t', str(seg), '-i', os.path.join(pasta, sl['bg'])]
        filtros, atual = [], '[0:v]'
        for j, (c, ini) in enumerate(zip(sl['camadas'], agenda(sl['camadas'])), 1):
            ins += ['-loop', '1', '-t', str(seg), '-i', os.path.join(pasta, c['png'])]
            st, d = ini / 1000, DUR[c['fx']] / 1000
            prog = f'max(0,1-(t-{st})/{d})'
            dx = f'{c["x"]}+36*{prog}' if c['fx'] == 'slide' else str(c['x'])
            dy = f'{c["y"]}+28*{prog}' if c['fx'] in ('float', 'wipe_up', 'pop', 'zoom') else str(c['y'])
            filtros.append(f'[{j}:v]format=rgba,fade=t=in:st={st}:d={d}:alpha=1[c{j}]')
            filtros.append(f"{atual}[c{j}]overlay=x='{dx}':y='{dy}':eval=frame[b{j}]")
            atual = f'[b{j}]'
        filtros.append(f'{atual}fade=t=in:st=0:d=0.35,fade=t=out:st={max(0.1, seg - 0.45):.2f}:d=0.45,fps=30,format=yuv420p[v]')
        parte = os.path.join(tmp, f'p{i:02d}.mp4')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *ins, '-filter_complex', ';'.join(filtros), '-map', '[v]',
                        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-t', str(seg), parte], check=True)
        partes.append(parte)
    lista = os.path.join(tmp, 'lista.txt')
    open(lista, 'w').write(''.join(f"file '{p}'\n" for p in partes))
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', saida], check=True)


def main():
    pasta, roteiro, base = sys.argv[1], sys.argv[2], sys.argv[3]
    segundos = [int(x) for x in re.findall(r'^## Slide \d+ · .*\((\d+) s\)$', open(roteiro, encoding='utf-8').read(), re.M)]
    manifest_path = os.path.join(pasta, 'manifest.json')
    if os.path.isfile(manifest_path):  # camadas: .pptx e .mp4 com motion
        manifest = json.load(open(manifest_path))
        if len(manifest) != len(segundos):
            sys.exit(f'{len(manifest)} slides e {len(segundos)} falas: precisam bater')
        pptx_animado(pasta, manifest, base + '.pptx')
        mp4_animado(pasta, manifest, segundos, base + '.mp4')
    else:
        pngs = sorted(glob.glob(os.path.join(pasta, 's[0-9][0-9].png')))
        if not pngs or len(pngs) != len(segundos):
            sys.exit(f'{len(pngs)} imagens e {len(segundos)} falas: precisam bater')
        pptx(pngs, base + '.pptx')
        mp4(pngs, segundos, base + '.mp4')
    print('ok', base + '.pptx', base + '.mp4', f'{sum(segundos)} s')


if __name__ == '__main__':
    main()
