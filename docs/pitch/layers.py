"""Separa cada slide em camadas para animar no .pptx e no .mp4 (3840x1080).

Uso: python3 layers.py <html> <pasta_saida>
Gera, por slide: sNN_bg.png (fundo sem os elementos animados) e sNN_LL.png (cada elemento com fundo transparente),
e manifest.json com posição (px na tela de 3840x1080), ordem e efeito de entrada de cada camada.
"""
import base64
import json
import os
import sys
import time
import urllib.request

# por slide (1 a 10): (seletor dentro do slide, efeito). A ordem da lista é a ordem de entrada.
# Marcação automática: todo bloco visível do slide vira camada (nada fica "colado" no fundo).
# Antes havia uma lista fixa por slide; a cada mudança de layout algo ficava de fora e aparecia sem animação.
GRUPOS = ['wide', 'l', 'r', 'ev', 'col', 'row', 'vert', 'tm4', 'tline', 'flow', 'cmp', 'seg', 'demo', 'one', 'traj']
FX = [('claim', 'float'), ('big', 'float'), ('edai', 'float'), ('brand', 'float'), ('sub2', 'float'),
      ('num', 'zoom'), ('card', 'zoom'), ('word', 'zoom'), ('step', 'slide'), ('tnode', 'slide'),
      ('pill', 'pop'), ('maptag', 'pop'), ('chart', 'wipe_up'), ('eyebrow', 'fade'), ('nota', 'fade'), ('shot', 'fade')]

MARCAR = r"""(() => {
  const GRUPOS = %s, FX = %s;
  const fxDe = e => {
    const cls = [...e.classList];
    for (const [c, fx] of FX) if (cls.includes(c)) return fx;
    if (e.tagName === 'IMG' || e.tagName === 'SVG' || e.tagName === 'svg') return 'fade';
    if (cls.includes('c')) return 'zoom';
    return 'fade';
  };
  const ehGrupo = e => {
    if (!e.children.length) return false;
    const cls = [...e.classList];
    if (cls.some(c => GRUPOS.includes(c))) return true;
    const st = (e.getAttribute('style') || '');
    return /display\\s*:\\s*(flex|grid)/.test(st) && e.children.length > 1 && !cls.includes('card') && !cls.includes('chart');
  };
  document.querySelectorAll('.slide').forEach(s => {
    let k = 0;
    const visita = el => {
      for (const filho of el.children) {
        const cs = getComputedStyle(filho);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (ehGrupo(filho)) { visita(filho); continue; }
        const r = filho.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        filho.dataset.anim = fxDe(filho);
        filho.dataset.ord = k++;
      }
    };
    visita(s);
  });
  return 1;
})()""" % (json.dumps(GRUPOS), json.dumps(FX))


def post(p, b):
    r = urllib.request.Request('http://127.0.0.1:9333/' + p, data=json.dumps(b).encode(), headers={'content-type': 'application/json'})
    try:
        return json.loads(urllib.request.urlopen(r, timeout=180).read().decode())
    except urllib.error.URLError:
        raise SystemExit('daemon cdpd fora do ar em 127.0.0.1:9333.\nSuba com: node tools/cdpd.mjs &   (e, no Chrome, marque "Allow remote debugging" em chrome://inspect/#remote-debugging)')


def main():
    src, out = os.path.abspath(sys.argv[1]), sys.argv[2]
    if not os.path.isfile(src):
        sys.exit('arquivo não existe: ' + src)
    os.makedirs(out, exist_ok=True)
    t = post('cdp', {'method': 'Target.createTarget', 'params': {'url': 'about:blank', 'background': True}})['result']['targetId']
    cdp = lambda m, p: post('cdp', {'target': t, 'method': m, 'params': p})
    ev = lambda e: post('eval', {'target': t, 'expr': e}).get('value')
    manifest = []
    try:
        cdp('Emulation.setDeviceMetricsOverride', {'width': 1920, 'height': 540, 'deviceScaleFactor': 2, 'mobile': False})
        cdp('Page.navigate', {'url': 'file://' + src})
        time.sleep(4)
        ev('document.fonts.ready.then(() => 1)')
        n = ev("document.querySelectorAll('.slide').length")
        ev(MARCAR)
        ev("(() => { const st = document.createElement('style'); st.id = '__lay'; document.head.appendChild(st); return 1; })()")
        for i in range(n):
            sel = f".slide:nth-of-type({i + 1})"
            top = ev(f"document.querySelectorAll('.slide')[{i}].getBoundingClientRect().top + scrollY")
            clip = {'x': 0, 'y': top, 'width': 1920, 'height': 540, 'scale': 1}
            # fundo: o slide sem os elementos animados
            ev(f"document.getElementById('__lay').textContent = '[data-anim]{{visibility:hidden !important}}'")
            shot = cdp('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': True, 'clip': clip})
            bg = os.path.join(out, f's{i + 1:02d}_bg.png')
            open(bg, 'wb').write(base64.b64decode(shot['result']['data']))
            alvos = json.loads(ev(f"""JSON.stringify([...document.querySelectorAll('.slide')[{i}].querySelectorAll('[data-anim]')]
                .sort((a, b) => a.dataset.ord - b.dataset.ord).map(e => {{ const r = e.getBoundingClientRect();
                return {{ord: +e.dataset.ord, fx: e.dataset.anim, x: r.left, y: r.top + scrollY, w: r.width, h: r.height}}; }}))"""))
            camadas = []
            cdp('Emulation.setDefaultBackgroundColorOverride', {'color': {'r': 0, 'g': 0, 'b': 0, 'a': 0}})
            for a in alvos:
                # só o alvo visível, sem fundo de página nem de slide
                css = (f"html,body,.slide{{background:transparent !important}} .slide::before{{display:none !important}}"
                       f" .slide *{{visibility:hidden !important}}"
                       f" .slide [data-ord='{a['ord']}'][data-anim], .slide [data-ord='{a['ord']}'][data-anim] *{{visibility:visible !important}}")
                ev(f"document.getElementById('__lay').textContent = {json.dumps(css)}")
                # só o slide atual tem esse data-ord visível: esconde os outros slides
                ev(f"document.querySelectorAll('.slide').forEach((s, j) => s.style.visibility = j === {i} ? '' : 'hidden')")
                pad = 6
                c = {'x': max(0, a['x'] - pad), 'y': a['y'] - pad, 'width': min(1920, a['w'] + 2 * pad), 'height': a['h'] + 2 * pad, 'scale': 1}
                shot = cdp('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': True, 'clip': c})
                png = os.path.join(out, f's{i + 1:02d}_{a["ord"]:02d}.png')
                open(png, 'wb').write(base64.b64decode(shot['result']['data']))
                # posição em px da tela final (3840x1080): 2x o CSS
                camadas.append({'png': os.path.basename(png), 'fx': a['fx'], 'x': round(2 * c['x']), 'y': round(2 * (c['y'] - top)),
                                'w': round(2 * c['width']), 'h': round(2 * c['height'])})
            ev("document.querySelectorAll('.slide').forEach(s => s.style.visibility = '')")
            cdp('Emulation.setDefaultBackgroundColorOverride', {})
            manifest.append({'bg': os.path.basename(bg), 'camadas': camadas})
            print(f'slide {i + 1}: {len(camadas)} camadas')
    finally:
        post('cdp', {'method': 'Target.closeTarget', 'params': {'targetId': t}})
    json.dump(manifest, open(os.path.join(out, 'manifest.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
