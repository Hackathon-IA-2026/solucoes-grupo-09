"""Lê e escreve no Discord pela aba do Chrome já logada, via daemon cdpd.mjs (127.0.0.1:9333).

  python3 discord.py tabs
  python3 discord.py read <url_do_canal> [--after <msg_id>] [--save-attachments <pasta>]
  python3 discord.py post <url_do_canal> <texto.txt> [--attach <arquivo> ...] [--reply <msg_id>] [--send]

<url_do_canal> = https://discord.com/channels/<guild>/<canal_ou_topico>
Sem --send, o post só digita, mostra o tamanho e APAGA o rascunho (nada é enviado).
Menção a uma pessoa no texto: {@username} (clica no autocomplete). @everyone vai como texto normal.
"""
import argparse, json, os, re, sys, time, urllib.request

DAEMON = 'http://127.0.0.1:9333/'
ED = "document.querySelector('[role=textbox][data-slate-editor]')"


def call(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(DAEMON + path, data=data, headers={'content-type': 'application/json'})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
    except urllib.error.URLError as e:
        sys.exit(f'daemon fora do ar ({e}); rode: node scripts/cdpd.mjs &')


class Tab:
    def __init__(self, tab_id=None):
        tabs = [t for t in call('list') if t['url'].startswith('https://discord.com/channels/')]
        tab = next((t for t in tabs if t['id'] == tab_id), None) if tab_id else (tabs[0] if tabs else None)
        if not tab:
            sys.exit('nenhuma aba do Chrome em discord.com/channels (abra o Discord logado numa aba)')
        self.id, self.origin = tab['id'], tab['url']

    def ev(self, expr):
        return call('eval', {'target': self.id, 'expr': expr}).get('value')

    def cdp(self, method, params):
        return call('cdp', {'target': self.id, 'method': method, 'params': params})

    def key(self, key, code, vk):
        for typ in ('keyDown', 'keyUp'):
            self.cdp('Input.dispatchKeyEvent', {'type': typ, 'key': key, 'code': code, 'windowsVirtualKeyCode': vk})

    def click(self, x, y):
        self.cdp('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y})
        for typ in ('mousePressed', 'mouseReleased'):
            self.cdp('Input.dispatchMouseEvent', {'type': typ, 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})

    def open(self, url):
        """Traz a aba para a frente (aba oculta perde teclas) e navega até o canal, esperando carregar."""
        call('cdp', {'method': 'Target.activateTarget', 'params': {'targetId': self.id}})
        chan = url.rstrip('/').split('/')[-1]
        if not (self.ev('location.href') or '').rstrip('/').endswith(chan):
            self.cdp('Page.navigate', {'url': url})
        for _ in range(30):
            time.sleep(1.5)
            if self.ev(f"location.href.includes('{chan}') && document.querySelectorAll('li[id^=\"chat-messages-{chan}-\"]').length > 0"):
                time.sleep(2)
                return chan
        sys.exit('canal não carregou (leitura vazia é inconclusiva)')

    def draft(self):
        return self.ev(ED + ".innerText.replace(/[\\ufeff\\s]/g,'')") or ''

    def clear_draft(self):
        """Seleciona tudo pelo comando do editor (seleção via Range não é respeitada pelo Slate) e apaga."""
        self.ev(f"{ED}.focus()")
        mod = 4 if sys.platform == 'darwin' else 2
        self.cdp('Input.dispatchKeyEvent', {'type': 'rawKeyDown', 'key': 'a', 'code': 'KeyA', 'windowsVirtualKeyCode': 65, 'modifiers': mod, 'commands': ['selectAll']})
        self.cdp('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'a', 'code': 'KeyA', 'windowsVirtualKeyCode': 65, 'modifiers': mod})
        time.sleep(0.3)
        for typ in ('rawKeyDown', 'keyUp'):
            self.cdp('Input.dispatchKeyEvent', {'type': typ, 'key': 'Backspace', 'code': 'Backspace', 'windowsVirtualKeyCode': 8})
        time.sleep(0.8)

    def back(self):
        """Devolve a aba ao canal em que o usuário estava."""
        if (self.ev('location.href') or '') != self.origin:
            self.cdp('Page.navigate', {'url': self.origin})


READ_JS = r"""(() => { let last = null; return [...document.querySelectorAll('li[id^="chat-messages-CHAN-"]')].map(li => {
  const id = li.id.split('-').pop();
  const u = li.querySelector('h3 [class*=username]'); if (u) last = u.textContent;
  return { id, author: last, time: li.querySelector('time')?.getAttribute('datetime') || null,
    text: document.getElementById('message-content-' + id)?.innerText || '',
    attachments: [...new Set([...li.querySelectorAll('a[href*="cdn.discordapp.com/attachments"]')].map(a => a.href))] };
}); })()"""


def cmd_read(a, tab):
    chan = tab.open(a.url)
    # rola até o fim para pegar as mais recentes
    tab.ev("(()=>{const s=document.querySelector('[class*=messagesWrapper] [class*=scroller]'); if(s) s.scrollTop=s.scrollHeight;})()")
    time.sleep(1.5)
    msgs = tab.ev(READ_JS.replace('CHAN', chan)) or []
    if a.after:
        msgs = [m for m in msgs if int(m['id']) > int(a.after)]
    for m in msgs:
        names = [u.split('?')[0].split('/')[-1] for u in m['attachments']]
        print(f"[{(m['time'] or '')[:16]}] {m['author']} (id {m['id']}): {m['text']}" + (f"  [anexos: {', '.join(names)}]" if names else ''))
        if a.save_attachments:
            os.makedirs(a.save_attachments, exist_ok=True)
            for u in m['attachments']:
                dest = os.path.join(a.save_attachments, f"{m['id']}_{u.split('?')[0].split('/')[-1]}")
                req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
                open(dest, 'wb').write(urllib.request.urlopen(req, timeout=60).read())
                print('   salvo:', dest)


REPLY_BAR = "(()=>{const f=document.querySelector('form'); const t=f?f.innerText:''; return /Replying to|Respondendo/.test(t);})()"


def arm_reply(tab, chan, msg_id):
    """Resposta nativa do Discord pelo menu de contexto: botão direito na mensagem, item "Reply", confere a barra "Replying to".
    (O botão de hover fica fora do li e some quando o mouse sintético chega nele; o menu de contexto não depende de hover.)"""
    li = f"document.getElementById('chat-messages-{chan}-{msg_id}')"
    if not tab.ev(f"!!{li}"):
        tab.cdp('Page.navigate', {'url': f'https://discord.com/channels/{tab.origin.split("/")[4]}/{chan}/{msg_id}'})
        time.sleep(4)
        if not tab.ev(f"!!{li}"):
            sys.exit(f'mensagem {msg_id} não está carregada no canal {chan}')
    tab.ev(f"{li}.scrollIntoView({{block:'center'}})")
    time.sleep(0.8)
    x, y = tab.ev(f"(()=>{{const b={li}.getBoundingClientRect(); const top=Math.max(b.y, 200), bot=Math.min(b.bottom, innerHeight-200); return [b.x+b.width/2, (top+bot)/2];}})()")
    # camada invisível de um menu/popout anterior (pointerCover) engole o clique: dispensar com um clique esquerdo antes
    for _ in range(3):
        if not tab.ev(f"(()=>{{const e=document.elementFromPoint({x},{y}); return !!(e && /pointerCover|layerContainer/.test(e.className||''));}})()"):
            break
        tab.click(x, y)
        time.sleep(0.6)
    tab.cdp('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y})
    time.sleep(0.3)
    for typ in ('mousePressed', 'mouseReleased'):
        tab.cdp('Input.dispatchMouseEvent', {'type': typ, 'x': x, 'y': y, 'button': 'right', 'clickCount': 1})
    time.sleep(1.0)
    pos = tab.ev("(()=>{const it=[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(e=>/^(Reply|Responder)$/.test((e.innerText||'').trim())); if(!it) return null; const b=it.getBoundingClientRect(); return [b.x+b.width/2, b.y+b.height/2];})()")
    if not pos:
        tab.key('Escape', 'Escape', 27)
        sys.exit('item "Reply" não apareceu no menu de contexto da mensagem')
    tab.click(*pos)
    time.sleep(0.8)
    if not tab.ev(REPLY_BAR):
        sys.exit('a barra "Replying to" não apareceu; nada foi digitado')
    print('respondendo à mensagem', msg_id)


def cmd_post(a, tab):
    text = open(a.text_file, encoding='utf-8').read().rstrip('\n')
    est = len(re.sub(r'\{@[^}]+\}', 'x' * 22, text))
    if est > 1990:
        sys.exit(f'~{est} caracteres: acima do limite de 2000 do Discord, divida a mensagem')
    chan = tab.open(a.url)
    if tab.draft():
        sys.exit('já existe rascunho no composer deste canal; confira no Chrome antes de postar')
    if a.reply:
        arm_reply(tab, chan, a.reply)
    if a.attach:
        paths = [os.path.abspath(x) for x in a.attach]  # relativo vira arquivo vazio no Chrome
        for path in paths:
            if not os.path.isfile(path) or os.path.getsize(path) == 0:
                sys.exit(f'arquivo inexistente ou vazio: {path}')
        doc = tab.cdp('DOM.getDocument', {'depth': 0})['result']['root']['nodeId']
        node = tab.cdp('DOM.querySelectorAll', {'nodeId': doc, 'selector': 'input[type=file]'})['result']['nodeIds'][0]
        tab.cdp('DOM.setFileInputFiles', {'nodeId': node, 'files': paths})
        time.sleep(4 + 4.0 * sum(os.path.getsize(p) for p in paths) / 1e6)  # vídeo grande demora a processar antes de aparecer no composer  # arquivo grande (vídeo) precisa de tempo para o Discord processar antes do envio
        for path in paths:
            name = json.dumps(os.path.basename(path))
            if not tab.ev(f"(()=>{{const f=document.querySelector('form')||document; return [...f.querySelectorAll('li,[class*=\"attachment\"],[class*=\"upload_\"]')].some(e=>(e.innerText||'').includes({name}));}})()"):
                sys.exit(f'o anexo {name} não apareceu no composer; nada foi enviado')
    tab.ev(f"{ED}.focus()")
    # blocos inteiros num único insertText: se cada linha entra separada, a quebra de linha depois de "> " continua a citação
    for part in re.split(r'(\{@[^}]+\})', text):
        if not part:
            continue
        if part.startswith('{@'):
            tab.cdp('Input.insertText', {'text': '@' + part[2:-1]})
            time.sleep(1.5)
            pos = tab.ev("(()=>{const o=document.querySelector('[role=listbox] [role=option]'); if(!o) return null; const b=o.getBoundingClientRect(); return [b.x+b.width/2, b.y+b.height/2];})()")
            if pos:
                tab.click(*pos)
            else:
                print('aviso: menção sem autocomplete:', part)
            time.sleep(0.6)
        else:
            tab.cdp('Input.insertText', {'text': part})
        time.sleep(0.15)
    time.sleep(0.8)
    print('rascunho digitado:', len(tab.ev(ED + '.innerText') or ''), 'caracteres')
    if not a.send:
        tab.clear_draft()
        if a.reply:
            tab.key('Escape', 'Escape', 27)  # desarma a barra "Replying to"
        print('modo teste (sem --send): rascunho apagado, nada enviado' if not tab.draft() else 'ATENÇÃO: rascunho ficou no composer')
        return
    tab.key('Enter', 'Enter', 13)
    time.sleep(2)
    if tab.draft():  # teclas CDP não chegaram: Enter sintético no editor
        tab.ev(f"(()=>{{const ed={ED}; ed.focus(); const o={{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}}; ed.dispatchEvent(new KeyboardEvent('keydown',o)); ed.dispatchEvent(new KeyboardEvent('keyup',o));}})()")
        time.sleep(3)
    if tab.draft():  # último recurso: clique no fim do textbox + End + Enter completo
        x, y = tab.ev(f"(()=>{{const b={ED}.getBoundingClientRect(); return [b.right-20, b.bottom-8];}})()")
        tab.click(x, y)
        time.sleep(0.4)
        tab.key('End', 'End', 35)
        for typ, extra in (('rawKeyDown', {}), ('char', {'text': '\r'}), ('keyUp', {})):
            tab.cdp('Input.dispatchKeyEvent', {'type': typ, 'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13, **extra})
        time.sleep(3)
    if tab.draft():
        sys.exit('FALHOU: o rascunho continua no composer')
    time.sleep(1.5)
    last = tab.ev("(()=>{const l=[...document.querySelectorAll('li[id^=\"chat-messages-\"]')].pop(); return l ? l.id.split('-').pop()+' | anexos: '+l.querySelectorAll('a[href*=\"cdn.discordapp.com/attachments\"]').length+' | '+(l.querySelector('[id^=message-content-]')?.innerText||'').slice(0,120) : null;})()")
    print('enviado; última mensagem no canal:', last)
    if last and os.environ.get('DISCORD_POST_LOG'):  # registra os ids dos meus posts, para a leitura separar o que é meu do que o dono da conta escreveu
        open(os.environ['DISCORD_POST_LOG'], 'a').write(last.split(' | ')[0] + '\n')
    if a.attach and last:
        n = int(re.search(r'anexos: (\d+)', last).group(1))
        if n < len(a.attach):  # cada anexo pode ter mais de um link (download e prévia), por isso >= e não ==
            sys.exit(f'ATENÇÃO: a mensagem saiu com {n} link(s) de anexo para {len(a.attach)} arquivo(s); confira e reenvie se faltar')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--tab', help='id da aba (de `tabs`); padrão: a primeira aba do Discord')
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('tabs')
    r = sub.add_parser('read'); r.add_argument('url'); r.add_argument('--after'); r.add_argument('--save-attachments')
    w = sub.add_parser('post'); w.add_argument('url'); w.add_argument('text_file'); w.add_argument('--attach', action='append', help='arquivo a anexar (repetir para vários)'); w.add_argument('--reply', help='id da mensagem a responder (resposta nativa do Discord; o autor é marcado automaticamente)'); w.add_argument('--send', action='store_true')
    a = p.parse_args()
    if a.cmd == 'tabs':
        for t in call('list'):
            print(t['id'], '|', t['title'][:60], '|', t['url'][:100])
        return
    tab = Tab(a.tab)
    try:
        cmd_read(a, tab) if a.cmd == 'read' else cmd_post(a, tab)
    finally:
        tab.back()


if __name__ == '__main__':
    main()
