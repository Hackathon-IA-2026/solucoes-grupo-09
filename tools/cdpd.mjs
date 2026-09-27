// Daemon CDP: UMA conexão persistente com o Chrome (uma permissão só) + HTTP local para comandos.
//   node cdpd.mjs            # sobe em http://127.0.0.1:9333
//   GET  /list
//   POST /eval       {"target": "<targetId>|discord", "expr": "..."}
//   POST /scrapeDom  {"out": "arquivo.json"}
import fs from "node:fs";
import http from "node:http";

const home = process.env.HOME;
const portFile = `${home}/Library/Application Support/Google/Chrome/DevToolsActivePort`;
const [port, wsPath] = fs.readFileSync(portFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const browserWs = `ws://127.0.0.1:${port}${wsPath}`;

const ws = new WebSocket(browserWs);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws error")); });
ws.onclose = () => { console.error("conexão com o Chrome fechada"); process.exit(1); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessions = new Map(); // targetId -> sessionId (reaproveita para não pedir permissão de novo)

async function pages() {
  const { targetInfos } = await send("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page");
}
async function attach(target) {
  let targetId = target;
  if (!target || target === "discord") {
    const t = (await pages()).find((t) => /discord\.com\/channels\//.test(t.url));
    if (!t) throw new Error("nenhuma aba do Discord aberta");
    targetId = t.targetId;
  }
  if (sessions.has(targetId)) return sessions.get(targetId);
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  sessions.set(targetId, sessionId);
  return sessionId;
}
async function evalIn(sessionId, expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const SCROLLER = `(document.querySelector('[data-list-id="chat-messages"]')?.closest('[class*="scroller"]') || document.querySelector('main [class*="scroller"]'))`;
const COLLECT = `(() => {
  const s = ${SCROLLER};
  const items = [...document.querySelectorAll('li[id^="chat-messages-"]')];
  const outArr = items.map((li) => {
    const id = li.id.split('-').pop();
    const author = li.querySelector('[class*="username"]')?.innerText || null;
    const time = li.querySelector('time')?.getAttribute('datetime') || null;
    const content = li.querySelector('[id^="message-content-"]')?.innerText || '';
    const reply = li.querySelector('[id^="message-reply-context-"]')?.innerText || null;
    const links = [...li.querySelectorAll('a[href]')].map(a => a.href).filter(h => /cdn\\.discordapp\\.com|media\\.discordapp\\.net|^https?:\\/\\/(?!discord\\.com)/.test(h));
    const imgs = [...li.querySelectorAll('img[src*="cdn.discordapp.com"], img[src*="media.discordapp.net"]')].map(i => i.src);
    const embed = li.querySelector('article')?.innerText || null;
    return { id, author, time, content, reply, links: [...new Set(links)], imgs: [...new Set(imgs)], embed };
  });
  return { items: outArr, scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight };
})()`;

async function scrapeDom(out, log) {
  const sessionId = await attach("discord");
  const ev = (e) => evalIn(sessionId, e);
  const box = await ev(`(() => { const r = ${SCROLLER}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, sessionId);
  let stable = 0, lastFirst = null;
  for (let i = 0; i < 400 && stable < 8; i++) {
    for (let k = 0; k < 6; k++) {
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -2000 }, sessionId);
      await sleep(120);
    }
    await sleep(1200);
    const first = await ev(`(() => { const f = document.querySelector('li[id^="chat-messages-"]'); return f ? f.id : null; })()`);
    stable = first === lastFirst ? stable + 1 : 0;
    lastFirst = first;
    if (i % 10 === 0) log(`iter ${i} topo atual ${first}`);
  }
  log(`topo: ${lastFirst}`);
  const byId = new Map();
  let lastAuthor = null;
  for (let guard = 0; guard < 2000; guard++) {
    const r = await ev(COLLECT);
    for (const m of r.items) {
      if (m.author) lastAuthor = m.author; else m.author = lastAuthor;
      if (!byId.has(m.id)) byId.set(m.id, m);
      else if (!byId.get(m.id).author && m.author) byId.get(m.id).author = m.author;
    }
    if (r.scrollTop + r.clientHeight >= r.scrollHeight - 5) break;
    await ev(`(() => { const s = ${SCROLLER}; s.scrollTop = s.scrollTop + s.clientHeight * 0.7; return s.scrollTop; })()`);
    await sleep(700);
  }
  const msgs = [...byId.values()].map((m) => ({ ...m, time: m.time || new Date(Number((BigInt(m.id) >> 22n) + 1420070400000n)).toISOString() }))
    .sort((a, b) => (a.id.length - b.id.length) || a.id.localeCompare(b.id));
  fs.writeFileSync(out, JSON.stringify(msgs, null, 1));
  return { count: msgs.length, out, first: msgs[0]?.time, last: msgs.at(-1)?.time };
}

const readBody = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d ? JSON.parse(d) : {})); });
http.createServer(async (req, res) => {
  const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    if (req.url === "/list") return reply(200, (await pages()).map((t) => ({ id: t.targetId, title: t.title, url: t.url })));
    const body = await readBody(req);
    if (req.url === "/eval") return reply(200, { value: await evalIn(await attach(body.target), body.expr) });
    if (req.url === "/cdp") return reply(200, { result: await send(body.method, body.params || {}, body.target ? await attach(body.target) : undefined) });
    if (req.url === "/scrapeDom") return reply(200, await scrapeDom(body.out, (m) => console.error(m)));
    reply(404, { error: "rota desconhecida" });
  } catch (e) {
    reply(500, { error: e.message });
  }
}).listen(9333, "127.0.0.1", () => console.log("cdpd em http://127.0.0.1:9333"));
