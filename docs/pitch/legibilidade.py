"""Checkpoint de legibilidade: toda letra visível no slide precisa ser enxergável no telão.

Uso: python3 legibilidade.py wattsteer-pitch-final-vN.html   (precisa do daemon cdpd em 127.0.0.1:9333)
Mede, no Chrome, o menor tamanho de fonte de todo texto visível de cada slide (canvas 1440x810).
Sai com código 1 se algum texto ficar abaixo de MIN_PX.
"""
import json
import os
import sys
import time
import urllib.request

MIN_PX = 18

MEDIR = r"""JSON.stringify([...document.querySelectorAll('.slide')].map((s, i) => {
  const ruins = [];
  const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = n.textContent.trim();
    if (!t) continue;
    const el = n.parentElement;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    let px = parseFloat(cs.fontSize);
    const svg = el.closest('svg');  // texto de gráfico: escala pelo tamanho desenhado
    if (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) px = px * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    if (px < %d) ruins.push(Math.round(px * 10) / 10 + 'px: ' + t.slice(0, 50));
  }
  return { slide: i + 1, ruins };
}))""" % MIN_PX


def post(p, b):
    r = urllib.request.Request('http://127.0.0.1:9333/' + p, data=json.dumps(b).encode(), headers={'content-type': 'application/json'})
    return json.loads(urllib.request.urlopen(r, timeout=120).read().decode())


def main():
    src = os.path.abspath(sys.argv[1])
    if not os.path.isfile(src):
        sys.exit(f'arquivo não existe: {src}')
    t = post('cdp', {'method': 'Target.createTarget', 'params': {'url': 'about:blank', 'background': True}})['result']['targetId']
    try:
        post('cdp', {'target': t, 'method': 'Emulation.setDeviceMetricsOverride', 'params': {'width': 1440, 'height': 810, 'deviceScaleFactor': 1, 'mobile': False}})
        post('cdp', {'target': t, 'method': 'Page.navigate', 'params': {'url': 'file://' + src}})
        time.sleep(4)
        post('eval', {'target': t, 'expr': 'document.fonts.ready.then(() => 1)'})
        res = json.loads(post('eval', {'target': t, 'expr': MEDIR})['value'])
    finally:
        post('cdp', {'method': 'Target.closeTarget', 'params': {'targetId': t}})
    total = 0
    for r in res:
        print(f"Slide {r['slide']}: " + ('ok' if not r['ruins'] else f"{len(r['ruins'])} texto(s) abaixo de {MIN_PX}px"))
        for x in r['ruins'][:8]:
            print('  -', x)
        total += len(r['ruins'])
    print(f'\nTOTAL: {total} texto(s) pequeno(s)' + ('' if total else f' · toda letra visível tem {MIN_PX}px ou mais'))
    sys.exit(1 if total else 0)


if __name__ == '__main__':
    main()
