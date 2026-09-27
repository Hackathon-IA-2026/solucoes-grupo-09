"""Embute o vídeo do time (reel) num slide do .pptx gerado pelo build_entrega.py.

Uso: python3 pptx_com_video.py <deck.pptx> <reel.mp4> <poster.jpg> <slide> <x> <y> <w> <h> <saida.pptx>
x, y, w, h em pixels da tela de 3840x1080 (a mesma medida do manifest das camadas).

O deck original não é alterado: a saída é um arquivo novo. O vídeo fica por cima do quadro do slide e
toca com um clique (o PowerPoint mostra os controles ao passar o mouse).
"""
import shutil
import sys
import zipfile

EMU = 24384000 // 3840  # 6350 EMU por pixel da tela de 3840x1080
NS_VIDEO = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video'
NS_MEDIA = 'http://schemas.microsoft.com/office/2007/relationships/media'
NS_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'


def pic_video(spid, rid_poster, rid_video, rid_media, x, y, w, h):
    return (f'<p:pic><p:nvPicPr><p:cNvPr id="{spid}" name="Reel WattSteer">'
            '<a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="" action="ppaction://media"/>'
            '</p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>'
            f'<p:nvPr><a:videoFile r:link="{rid_video}"/>'
            '<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}">'
            f'<p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="{rid_media}"/>'
            '</p:ext></p:extLst></p:nvPr></p:nvPicPr>'
            f'<p:blipFill><a:blip r:embed="{rid_poster}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
            f'<p:spPr><a:xfrm><a:off x="{x * EMU}" y="{y * EMU}"/><a:ext cx="{w * EMU}" cy="{h * EMU}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>')


def main():
    deck, reel, poster, slide, x, y, w, h, saida = sys.argv[1:10]
    slide, x, y, w, h = int(slide), int(x), int(y), int(w), int(h)
    shutil.copyfile(deck, saida)
    alvo = f'ppt/slides/slide{slide}.xml'
    rels = f'ppt/slides/_rels/slide{slide}.xml.rels'

    with zipfile.ZipFile(deck) as z:
        itens = {n: z.read(n) for n in z.namelist()}
    if alvo not in itens:
        sys.exit(f'{alvo} não existe no deck')

    # ids livres a partir dos que o slide já usa
    usados = [int(t.split('"')[0]) for t in itens[rels].decode().split('Id="rId')[1:]] or [1]
    n = max(usados)
    rid_poster, rid_video, rid_media = f'rId{n + 1}', f'rId{n + 2}', f'rId{n + 3}'

    xml = itens[alvo].decode()
    spid = max(int(t.split('"')[0]) for t in xml.split('<p:cNvPr id="')[1:]) + 1
    xml = xml.replace('</p:spTree>', pic_video(spid, rid_poster, rid_video, rid_media, x, y, w, h) + '</p:spTree>')
    itens[alvo] = xml.encode()

    novos = (f'<Relationship Id="{rid_poster}" Type="{NS_IMAGE}" Target="../media/reel-poster.jpg"/>'
             f'<Relationship Id="{rid_video}" Type="{NS_VIDEO}" Target="../media/reel.mp4"/>'
             f'<Relationship Id="{rid_media}" Type="{NS_MEDIA}" Target="../media/reel.mp4"/>')
    itens[rels] = itens[rels].decode().replace('</Relationships>', novos + '</Relationships>').encode()

    ct = itens['[Content_Types].xml'].decode()
    for ext, tipo in [('mp4', 'video/mp4'), ('jpg', 'image/jpeg')]:
        if f'Extension="{ext}"' not in ct:
            ct = ct.replace('<Default Extension="png"', f'<Default Extension="{ext}" ContentType="{tipo}"/><Default Extension="png"')
    itens['[Content_Types].xml'] = ct.encode()

    itens['ppt/media/reel.mp4'] = open(reel, 'rb').read()
    itens['ppt/media/reel-poster.jpg'] = open(poster, 'rb').read()

    with zipfile.ZipFile(saida, 'w', zipfile.ZIP_DEFLATED) as z:
        for nome, dados in itens.items():
            z.writestr(nome, dados)
    print(f'ok {saida}: vídeo no slide {slide}, {x},{y} {w}x{h}')


if __name__ == '__main__':
    main()
