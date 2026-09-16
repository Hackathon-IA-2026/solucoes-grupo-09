"""A page for trying the service by hand.

The debug routes answer precisely, in JSON, and are useless to someone who has
not read `app.py` first. This is the same three questions — what the record
becomes, what the search returned, what the gates did with it — arranged so that
a person can ask them, on one page, without a terminal.

It is part of the internal surface. The product never renders from here.
"""

from __future__ import annotations

import json
from pathlib import Path

GOLDSET = Path("eval/goldset.jsonl")


def sample_records() -> list[dict]:
    """Real records to start from, so nobody has to invent a description.

    The evaluation set is exactly these: rows of the ONS constrained-off record.
    If it has not been built yet the page still works, with an empty list and a
    free-text field.
    """
    if not GOLDSET.exists():
        return []
    records = []
    for line in GOLDSET.read_text().splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        records.append(
            {
                "subsystem": case["subsystem"],
                "date": case["date"],
                "reason": case.get("reason"),
                "description": case["description"],
                "expect_document": case.get("expect_document"),
            }
        )
    return records


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WattSteer evidence</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #fff; --ink: #1a1a18; --muted: #6b6b66;
    --line: #e4e4e0; --accent: #1f6f4a; --bad: #9a2f2f; --warn: #8a6d1f;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #17171a; --panel: #1f1f23; --ink: #ececea; --muted: #9a9a94;
      --line: #32323a; --accent: #5fbf8f; --bad: #e08585; --warn: #d9bc6a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header { padding: 22px 16px 10px; max-width: 980px; margin: 0 auto; }
  h1 { font-size: 21px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13.5px; margin: 0; }
  main { max-width: 980px; margin: 0 auto; padding: 0 16px 64px; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px; margin: 14px 0;
  }
  label { display: block; font-size: 12.5px; color: var(--muted); margin: 10px 0 4px; }
  select, input, textarea {
    width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px;
    background: var(--bg); color: var(--ink); font: inherit;
  }
  textarea { font-family: var(--mono); font-size: 13px; min-height: 68px; resize: vertical; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .row > div { flex: 1 1 150px; }
  button {
    margin: 14px 8px 0 0; padding: 9px 15px; border: 1px solid var(--line);
    border-radius: 7px; background: var(--ink); color: var(--panel);
    font: inherit; font-weight: 550; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--ink); }
  button:disabled { opacity: 0.45; cursor: progress; }
  .q { font-family: var(--mono); font-size: 12.5px; color: var(--muted); margin-top: 12px; white-space: pre-wrap; }
  .verdict { font-weight: 650; font-size: 15px; }
  .found { color: var(--accent); } .refused { color: var(--bad); } .waiting { color: var(--warn); }
  .claim { border-left: 3px solid var(--accent); padding: 2px 0 2px 12px; margin: 14px 0; }
  .claim.refused { border-left-color: var(--bad); }
  blockquote {
    margin: 8px 0; padding: 9px 12px; background: var(--bg); border: 1px solid var(--line);
    border-radius: 7px; font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap;
  }
  .src { font-size: 12.5px; color: var(--muted); }
  .src a { color: inherit; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 550; }
  code { font-family: var(--mono); font-size: 12px; }
  .pill {
    display: inline-block; padding: 1px 7px; border: 1px solid var(--line);
    border-radius: 99px; font-size: 11.5px; color: var(--muted); margin-right: 6px;
  }
  .note { color: var(--muted); font-size: 12.5px; margin-top: 10px; }
</style>
</head>
<body>
<header>
  <h1>WattSteer evidence</h1>
  <p class="sub">A curtailment record in, the passage that states the rule out — or a refusal with the gate that produced it.</p>
</header>
<main>
  <div class="card">
    <label for="sample">A record the ONS published</label>
    <select id="sample"></select>

    <div class="row">
      <div><label for="subsystem">Subsystem</label>
        <select id="subsystem"><option>NE</option><option>N</option><option>SE</option><option>S</option></select></div>
      <div><label for="date">Date</label><input id="date" type="date"></div>
      <div><label for="reason">Reason</label>
        <select id="reason"><option value="">—</option><option>CNF</option><option>REL</option><option>ENE</option></select></div>
    </div>

    <label for="description">Description, as the record writes it</label>
    <textarea id="description"></textarea>

    <button id="build">Build the evidence</button>
    <button id="look" class="ghost">Only search</button>
    <p class="note">Building calls a model on a free tier. It takes a few seconds, and can answer “waiting for quota”, which is not an error: it says when it can resume.</p>
    <div class="q" id="question"></div>
  </div>

  <div id="out"></div>

  <div class="card">
    <div class="q" id="status">…</div>
  </div>
</main>

<script>
const RECORDS = __RECORDS__;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function fill(i) {
  const r = RECORDS[i];
  if (!r) return;
  $("subsystem").value = r.subsystem || "NE";
  $("date").value = r.date;
  $("reason").value = r.reason || "";
  $("description").value = r.description;
  preview();
}

function params() {
  const p = new URLSearchParams({ subsystem: $("subsystem").value, target_date: $("date").value });
  if ($("reason").value) p.set("reason", $("reason").value);
  if ($("description").value.trim()) p.set("description", $("description").value.trim());
  return p;
}

// D-1 at 19:00 Brasilia, the late gate: nothing published after it is visible.
function gateAt() {
  const d = new Date($("date").value + "T00:00:00Z");
  d.setUTCHours(d.getUTCHours() - 5);
  return d.toISOString().replace(/\\.\\d+Z$/, "Z");
}

async function preview() {
  try {
    const r = await fetch("/internal/rag/question?" + params());
    const j = await r.json();
    $("question").textContent = "The question this becomes:\\n" + (j.question || "");
  } catch { $("question").textContent = ""; }
}

function citation(c) {
  const where = [c.locator?.page ? "page " + c.locator.page : null, c.locator?.section, c.locator?.table]
    .filter(Boolean).join(" · ");
  const when = c.published_at ? c.published_at.slice(0, 10) : "undeclared date";
  const name = [c.external_id, c.revision ? "rev " + c.revision : null].filter(Boolean).join(" ");
  return `<blockquote>${esc(c.quote)}</blockquote>
    <div class="src">${c.assembled ? '<span class="pill">assembled from cells</span>' : ""}
      ${esc(name)} — ${esc(where)} — published ${esc(when)}
      ${c.url ? ` — <a href="${esc(c.url)}" target="_blank" rel="noopener">open the document</a>` : ""}</div>`;
}

function render(doc) {
  const g = doc.trace?.generation || {};
  const verdict = doc.verdict === "found" ? "found"
    : (doc.reason || "").startsWith("quota") ? "waiting" : "refused";
  let html = `<div class="card">
    <div class="verdict ${verdict}">${esc(doc.verdict)}${doc.reason ? " — " + esc(doc.reason) : ""}</div>`;

  for (const item of doc.items || []) {
    html += `<div class="claim"><div>${esc(item.claim)}</div>
      <div class="src"><span class="pill">${esc(item.supports)}</span>
      <span class="pill">confidence ${esc(item.confidence)}</span></div>
      ${(item.citations || []).map(citation).join("")}</div>`;
  }

  const rejected = g.rejected || [];
  if (rejected.length) {
    html += `<p class="note">What the model tried to say, and the gate that refused it:</p>`;
    for (const r of rejected) {
      html += `<div class="claim refused"><div>${esc(r.claim)}</div>
        <div class="src">${(r.failures || []).map((f) =>
          `<span class="pill">${esc(f.code)}</span>${esc(f.detail || "")}`).join(" ")}</div>
        ${(r.quotes || []).filter(Boolean).map((q) => `<blockquote>${esc(q)}</blockquote>`).join("")}</div>`;
    }
  }

  const hits = doc.trace?.retrieval?.candidates || doc.candidates || [];
  html += table(hits);
  html += `<p class="note">${esc(g.provider || "no model")} ${esc(g.model || "")} · ${g.attempts || 0} attempt(s)
    · ${doc.trace?.retrieval?.hybrid_candidates ?? hits.length} candidates</p></div>`;
  $("out").innerHTML = html;
}

function table(hits) {
  if (!hits.length) return "";
  return `<table><tr><th>Document</th><th>Section</th><th>Vector</th><th>Text</th><th>Score</th></tr>` +
    hits.map((h) => `<tr><td>${esc(h.document || h.external_id || h.source || "")}</td>
      <td>${esc((h.locator?.section || h.section || h.section_path || "").slice(0, 70))}</td>
      <td>${h.vector_rank ?? "—"}</td><td>${h.text_rank ?? "—"}</td>
      <td><code>${(h.rrf ?? h.score ?? 0).toFixed(4)}</code></td></tr>`).join("") + `</table>`;
}

async function call(url, options, button) {
  button.disabled = true;
  $("out").innerHTML = `<div class="card"><span class="q">asking…</span></div>`;
  try {
    const r = await fetch(url, options);
    const j = await r.json();
    if (j.error) {
      $("out").innerHTML = `<div class="card"><div class="verdict refused">${esc(j.error.code)}</div>
        <p class="note">${esc(j.error.message)}</p></div>`;
    } else if (j.hits) {
      $("out").innerHTML = `<div class="card"><div class="verdict">${j.hits.length} passages</div>${table(j.hits)}</div>`;
    } else {
      render(j);
    }
  } catch (e) {
    $("out").innerHTML = `<div class="card"><div class="verdict refused">the service did not answer</div>
      <p class="note">${esc(e.message)}</p></div>`;
  } finally {
    button.disabled = false;
  }
}

$("build").onclick = (e) =>
  call("/internal/rag/evidence?" + params() + "&gate_at=" + encodeURIComponent(gateAt()), { method: "POST" }, e.target);
$("look").onclick = (e) =>
  call("/internal/rag/search?q=" + encodeURIComponent($("description").value.trim() || "limitação"), {}, e.target);

for (const el of ["subsystem", "date", "reason", "description"]) $(el).oninput = preview;
$("sample").onchange = (e) => fill(e.target.value);

RECORDS.forEach((r, i) => {
  const o = document.createElement("option");
  o.value = i;
  o.textContent = `${r.date} ${r.subsystem} ${r.reason} — ${r.description.slice(0, 84)}`;
  $("sample").appendChild(o);
});
if (!RECORDS.length) {
  const o = document.createElement("option");
  o.textContent = "no evaluation set built — type a description below";
  $("sample").appendChild(o);
} else {
  fill(0);
}

(async () => {
  try {
    const [s, q] = await Promise.all([
      fetch("/internal/rag/status").then((r) => r.json()),
      fetch("/internal/llm/quota").then((r) => r.json()),
    ]);
    const keys = Object.entries(q.providers || {})
      .map(([name, v]) => `${name}: ${v.keys} key(s)${v.enabled ? "" : ", disabled"}`).join(" · ");
    const documents = (s.sources || []).reduce((total, row) => total + row.documents, 0);
    $("status").textContent =
      `${documents} documents · ${s.chunks?.total ?? "?"} passages · ${s.chunks?.embedded ?? "?"} with a vector`
      + ` · ${s.evidence?.total ?? 0} evidence documents built so far`
      + (keys ? ` — ${keys}` : "")
      + `\ncorpus ${s.corpus_version || "?"}`;
  } catch { $("status").textContent = "the service is up but did not report its corpus"; }
})();
</script>
</body>
</html>
"""


def page() -> str:
    return PAGE.replace("__RECORDS__", json.dumps(sample_records(), ensure_ascii=False))
