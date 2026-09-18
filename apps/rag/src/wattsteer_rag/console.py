"""A page for trying the service by hand.

The debug routes answer precisely, in JSON, and are useless to someone who has
not read `app.py` first. This page asks the same things (what the case becomes,
what the search returned, what the gates did with it) in numbered steps a
developer or a domain expert can follow without knowing the service: the
verdict in plain words, the quote with a link to its page in the official
document, and every gate as a named check, with its code beside it so the rule
can be found in `evidence.py`. A first version showed raw verdicts and ranks,
and a developer on the team could not tell what it did.

It is part of the internal surface. The product never renders from here.
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import REPO_ROOT

# Where the evaluation set can be. The relative path is the one a developer gets
# from `apps/rag`, and it stays first so an experiment in the working tree wins.
# The other two are the checkout and the image, which is a flat `/app` with no
# `apps/` above it: without that last candidate the deployed console has no
# records at all and offers "no evaluation set built" to every visitor, which is
# what it did until this list existed.
GOLDSETS = (
    Path("eval/goldset.jsonl"),
    REPO_ROOT / "apps" / "rag" / "eval" / "goldset.jsonl",
    REPO_ROOT / "eval" / "goldset.jsonl",
)


def goldset_path() -> Path | None:
    return next((path for path in GOLDSETS if path.exists()), None)


def sample_records() -> list[dict]:
    """Real records to start from, so nobody has to invent a description.

    The evaluation set is exactly these: rows of the ONS constrained-off record.
    If it has not been built yet the page still works, with an empty list and a
    free-text field.
    """
    path = goldset_path()
    if path is None:
        return []
    records = []
    for line in path.read_text().splitlines():
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
    --soft-ok: #e9f4ee; --soft-bad: #f8eaea; --soft-warn: #f7f1e1;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #17171a; --panel: #1f1f23; --ink: #ececea; --muted: #9a9a94;
      --line: #32323a; --accent: #5fbf8f; --bad: #e08585; --warn: #d9bc6a;
      --soft-ok: #1d2b24; --soft-bad: #2e1f1f; --soft-warn: #2c2718;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header, main { max-width: 980px; margin: 0 auto; padding: 0 16px; }
  header { padding-top: 22px; }
  main { padding-bottom: 64px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  h2 .n {
    display: inline-block; width: 22px; height: 22px; line-height: 22px; text-align: center;
    border-radius: 50%; background: var(--ink); color: var(--panel); font-size: 12px; margin-right: 8px;
  }
  .intro { color: var(--muted); font-size: 14px; margin: 0 0 6px; max-width: 760px; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px; margin: 14px 0;
  }
  label { display: block; font-size: 12.5px; color: var(--muted); margin: 10px 0 4px; }
  select, input, textarea {
    width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px;
    background: var(--bg); color: var(--ink); font: inherit;
  }
  textarea { font-family: var(--mono); font-size: 13px; min-height: 64px; resize: vertical; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .row > div { flex: 1 1 150px; }
  .modes { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .modes label {
    display: inline-flex; align-items: center; gap: 6px; margin: 0; padding: 7px 12px;
    border: 1px solid var(--line); border-radius: 99px; color: var(--ink); cursor: pointer; font-size: 14px;
  }
  .modes input { width: auto; margin: 0; }
  button {
    margin: 14px 8px 0 0; padding: 9px 15px; border: 1px solid var(--line);
    border-radius: 7px; background: var(--ink); color: var(--panel);
    font: inherit; font-weight: 550; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--ink); }
  button:disabled { opacity: 0.45; cursor: progress; }
  .q { font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; background: var(--bg);
       border: 1px solid var(--line); border-radius: 7px; padding: 9px 12px; }
  .banner { border-radius: 9px; padding: 14px 16px; }
  .banner.ok { background: var(--soft-ok); } .banner.bad { background: var(--soft-bad); }
  .banner.wait { background: var(--soft-warn); }
  .banner .title { font-weight: 650; font-size: 17px; }
  .ok .title { color: var(--accent); } .bad .title { color: var(--bad); } .wait .title { color: var(--warn); }
  .claim { border-left: 3px solid var(--accent); padding: 2px 0 2px 12px; margin: 12px 0 16px; }
  .claim.refused { border-left-color: var(--bad); }
  .claim .text { font-size: 15.5px; }
  blockquote {
    margin: 8px 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line);
    border-radius: 7px; font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap;
  }
  .src { font-size: 13px; color: var(--muted); }
  .src a { color: var(--accent); font-weight: 550; }
  .checks { list-style: none; padding: 0; margin: 6px 0 0; }
  .checks li { padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
  .checks li:last-child { border-bottom: 0; }
  .mark { display: inline-block; width: 20px; font-weight: 700; }
  .pass { color: var(--accent); } .fail { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 550; }
  code, .code { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .pill {
    display: inline-block; padding: 1px 8px; border: 1px solid var(--line);
    border-radius: 99px; font-size: 12px; color: var(--muted); margin-right: 6px;
  }
  .note { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
  details summary { cursor: pointer; font-weight: 600; font-size: 14px; }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <h1>WattSteer evidence: what did ONS publish about this?</h1>
  <p class="intro">You give it a curtailment record from ONS, or a question. It searches ONS's own
  documents (operating instructions, network procedures, daily bulletins, disturbance reports), asks
  a language model to answer <b>only by quoting them</b>, and then checks every quote mechanically.
  The result is either a passage you can open at its page in the official document, or a refusal
  that says which check failed. It never guesses, and it never says what caused a curtailment.</p>
</header>
<main>
  <div class="card">
    <h2><span class="n">1</span>What do you want to check?</h2>
    <div class="modes">
      <label><input type="radio" name="mode" value="record" checked> A curtailment record ONS published</label>
      <label><input type="radio" name="mode" value="question"> A question about what ONS published</label>
    </div>

    <div id="record-fields">
      <label for="sample">Pick a real record (or edit the fields below)</label>
      <select id="sample"></select>
      <label for="description">What ONS wrote in the record</label>
      <textarea id="description"></textarea>
      <label for="reason">Reason ONS declared</label>
      <select id="reason">
        <option value="">not given</option>
        <option value="CNF">CNF: electrical reliability limit</option>
        <option value="REL">REL: external equipment unavailable</option>
        <option value="ENE">ENE: more generation than load</option>
      </select>
    </div>

    <div id="question-fields" class="hidden">
      <label for="free">Your question, in Portuguese (the documents are)</label>
      <textarea id="free" placeholder="Ex.: Qual foi a demanda máxima do SIN em 06/09/2026?"></textarea>
    </div>

    <div class="row">
      <div><label for="subsystem">Subsystem</label>
        <select id="subsystem">
          <option value="NE">NE: Northeast</option><option value="N">N: North</option>
          <option value="SE">SE: Southeast/Centre-West</option><option value="S">S: South</option>
        </select></div>
      <div><label for="date">Day it is about</label><input id="date" type="date"></div>
      <div><label for="cutoff">Documents published up to</label>
        <select id="cutoff">
          <option value="gate">the evening before (what an operator had)</option>
          <option value="now">now (everything published so far)</option>
        </select></div>
    </div>
  </div>

  <div class="card">
    <h2><span class="n">2</span>What the service will ask the documents</h2>
    <div class="q" id="question">…</div>
    <button id="build">Find the evidence</button>
    <button id="look" class="ghost">Only search, no model</button>
    <button id="stored" class="ghost">Show the answer the app already stored</button>
    <p class="note">Finding the evidence calls a model on a free tier and takes a few seconds. If the
    provider's quota is spent it says so and when to try again; that is not an error.</p>
  </div>

  <div id="out"></div>

  <div class="card"><div class="code" id="status">…</div></div>
</main>

<script>
const RECORDS = __RECORDS__;
const $ = (id) => document.getElementById(id);
// When the service is reachable from the network it wants a token, and the page
// was opened with it in the address. Every call carries it back.
const KEY = new URLSearchParams(location.search).get("k");
const url = (path) => path + (KEY ? (path.includes("?") ? "&" : "?") + "k=" + encodeURIComponent(KEY) : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const mode = () => document.querySelector("input[name=mode]:checked").value;

// Every gate in evidence.py, in the words a reader needs. The code stays next
// to it, so anyone can find the rule in the source.
const CHECKS = [
  { codes: ["quote_not_in_chunk"], text: "The quote appears word for word in the document" },
  { codes: ["number_not_in_quote"], text: "Every number in the answer is inside the quote" },
  { codes: ["quote_without_substance"], text: "The quote states something (it is not just a heading)" },
  { codes: ["citation_not_the_named_document", "citation_from_another_day", "citation_from_another_event"],
    text: "The document is about this case (the instruction the record names; a bulletin or report of that day)" },
  { codes: ["locator_missing"], text: "The quote has a location: page, section or table" },
  { codes: ["causal_vocabulary"], text: "No cause-and-effect wording: WattSteer shows the rule, it does not claim a cause" },
  { codes: ["schema_invalid"], text: "The model answered in the required structure" },
];

const VERDICTS = {
  found: ["ok", "Answer found in an official ONS document", "Every quote below passed all the checks in step 5."],
  gates_rejected_all_claims: ["bad", "No answer: what the model proposed failed the checks",
    "Nothing unverified is shown as an answer. Step 5 lists what was proposed and which check refused it."],
  corpus_no_coverage_for_date: ["bad", "No answer: no document in the collection covers this",
    "The search found nothing published by the cutoff that matches the case."],
  quota: ["wait", "Waiting for the model provider's free quota", "Try again in a minute; nothing was stored as an answer."],
};

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
  if (mode() === "question") {
    if ($("free").value.trim()) p.set("question", $("free").value.trim());
  } else {
    if ($("reason").value) p.set("reason", $("reason").value);
    if ($("description").value.trim()) p.set("description", $("description").value.trim());
  }
  return p;
}

// "The evening before" is D-1 at 19:00 Brasilia (22:00 UTC), the late gate:
// nothing published after it is visible, as for an operator planning the day.
function gateAt() {
  if ($("cutoff").value === "now") return new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
  const d = new Date($("date").value + "T22:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().replace(/\\.\\d+Z$/, "Z");
}

async function preview() {
  $("record-fields").classList.toggle("hidden", mode() !== "record");
  $("question-fields").classList.toggle("hidden", mode() !== "question");
  if (mode() === "question") { $("question").textContent = $("free").value.trim() || "…"; return; }
  try {
    const r = await fetch(url("/internal/rag/question?" + params()));
    const j = await r.json();
    $("question").textContent = j.question || "…";
  } catch { $("question").textContent = "…"; }
}

// A PDF opens at the cited page; other sources open as they are.
function pageLink(c) {
  if (!c.url) return "";
  const page = /\\.pdf($|[?#])/i.test(c.url) ? c.locator?.page : null;
  const href = page ? c.url.split("#")[0] + "#page=" + page : c.url;
  return `<a href="${esc(href)}" target="_blank" rel="noopener">Open the official document${page ? " at page " + page : ""}</a>`;
}

function citation(c) {
  const name = [c.external_id || c.source, c.revision ? "rev. " + c.revision : null].filter(Boolean).join(", ");
  const where = [c.locator?.page ? "page " + c.locator.page : null, c.locator?.section, c.locator?.table]
    .filter(Boolean).join(" · ");
  const when = c.published_at ? c.published_at.slice(0, 10) : "date not declared";
  return `<blockquote>${esc(c.quote)}</blockquote>
    <div class="src"><b>${esc(name)}</b> · ${esc(where)} · published ${esc(when)}
      ${c.assembled ? '<span class="pill">quoted from table cells, in order</span>' : ""}<br>${pageLink(c)}</div>`;
}

function verdictOf(doc) {
  if (doc.verdict === "found") return VERDICTS.found;
  if ((doc.reason || "").startsWith("quota")) return VERDICTS.quota;
  // The gates refused everything, but there may have been nothing to refuse.
  if (doc.reason === "gates_rejected_all_claims" && !(doc.trace?.generation?.rejected || []).length) {
    return ["bad", "No answer: the model found nothing it could quote",
      "The passages in step 6 were searched, and none of them states the answer."];
  }
  return VERDICTS[doc.reason] || ["bad", "No answer", doc.reason || ""];
}

// With no failures, every check passed. With failures, only those are shown:
// a gate that stops early leaves the rest unevaluated, and a tick there would
// claim something nobody checked.
function checklist(failedCodes) {
  const shown = failedCodes.length
    ? CHECKS.filter((check) => check.codes.some((code) => failedCodes.includes(code)))
    : CHECKS;
  return `<ul class="checks">` + shown.map((check) => {
    const failed = check.codes.find((code) => failedCodes.includes(code));
    const mark = failed ? '<span class="mark fail">✗</span>' : '<span class="mark pass">✓</span>';
    return `<li>${mark}${esc(check.text)} <span class="code">(${esc(failed || check.codes[0])})</span></li>`;
  }).join("") + `</ul>`;
}

function render(doc) {
  const g = doc.trace?.generation || {};
  const [tone, title, sub] = verdictOf(doc);
  let html = `<div class="card"><h2><span class="n">3</span>Result</h2>
    <div class="banner ${tone}"><div class="title">${esc(title)}</div><div class="note">${esc(sub)}</div>
    <div class="code">verdict: ${esc(doc.verdict)}${doc.reason ? " · reason: " + esc(doc.reason) : ""}</div></div></div>`;

  const items = doc.items || [];
  if (items.length) {
    html += `<div class="card"><h2><span class="n">4</span>The answer, and where it is written</h2>`;
    for (const item of items) {
      html += `<div class="claim"><div class="text">${esc(item.claim)}</div>
        ${(item.citations || []).map(citation).join("")}
        <div class="src" style="margin-top:6px"><span class="pill">model confidence: ${esc(item.confidence)}</span>
        ${mode() === "record" && item.supports !== "NONE"
          ? `<span class="pill">ONS reason it relates to: ${esc(item.supports)}</span>` : ""}</div></div>`;
    }
    html += `</div>`;
  }

  const rejected = g.rejected || [];
  html += `<div class="card"><h2><span class="n">5</span>The checks every quote must pass</h2>`;
  if (items.length) {
    html += `<p class="note">The answer above passed all of them.</p>` + checklist([]);
  }
  if (rejected.length) {
    html += `<p class="note">What the model proposed and was refused, with the check that refused it
      (the other checks may not have run):</p>`;
    for (const r of rejected) {
      const codes = (r.failures || []).map((f) => f.code);
      html += `<div class="claim refused"><div class="text">${esc(r.claim)}</div>
        ${(r.quotes || []).filter(Boolean).map((q) => `<blockquote>${esc(q)}</blockquote>`).join("")}
        ${checklist(codes)}
        ${(r.failures || []).map((f) => `<div class="code">${esc(f.code)}: ${esc(f.detail || "")}</div>`).join("")}</div>`;
    }
  }
  if (!items.length && !rejected.length) {
    html += `<p class="note">The model proposed no quote, so there was nothing to check.</p>`;
  }
  html += `</div>`;

  const hits = doc.trace?.retrieval?.candidates || doc.candidates || [];
  html += `<div class="card"><h2><span class="n">6</span>What the search looked at</h2>`
    + candidates(hits)
    + `<p class="note">Model: ${esc(g.provider || "none")} ${esc(g.model || "")} · ${g.attempts || 0} attempt(s).
       Only documents published by ${esc(doc.gate_at ? doc.gate_at.slice(0, 16).replace("T", " ") + " UTC" : "the cutoff")}
       were searched.</p></div>`;
  $("out").innerHTML = html;
}

function candidates(hits) {
  if (!hits.length) return `<p class="note">The search returned no passages.</p>`;
  return `<details><summary>${hits.length} passages were given to the model (open to see them)</summary>
    <p class="note">The search runs two ways, by meaning (text embeddings) and by the exact words
    (full-text search), and merges the two rankings (reciprocal rank fusion). The model sees only these
    passages and may quote only from them.</p>
    <table><tr><th>Document</th><th>Section</th><th>Rank by meaning</th><th>Rank by words</th><th>Combined score</th></tr>` +
    hits.map((h) => `<tr><td>${esc(h.document || h.external_id || h.source || "")}</td>
      <td>${esc((h.locator?.section || h.section || h.section_path || "").slice(0, 70))}</td>
      <td>${h.vector_rank ?? "not ranked"}</td><td>${h.text_rank ?? "not ranked"}</td>
      <td><code>${(h.rrf ?? h.score ?? 0).toFixed(4)}</code></td></tr>`).join("") + `</table></details>`;
}

function published(j) {
  if (!j.rows.length) {
    $("out").innerHTML = `<div class="card"><div class="banner wait"><div class="title">Nothing stored for
      ${esc(j.subsystem)} on ${esc(j.target_date)}</div><div class="note">The daily job has not built this
      day yet. "Find the evidence" builds one now.</div></div></div>`;
    return;
  }
  const best = j.rows.find((r) => r.verdict === "found") || j.rows[0];
  render(best.payload);
  $("out").insertAdjacentHTML("afterbegin",
    `<div class="card"><p class="note">This is the stored answer the app shows, built
     ${esc(String(best.created_at).slice(0, 16).replace("T", " "))} UTC. No model ran to show it.
     ${j.rows.length} version(s) kept for this day. <code>corpus ${esc(best.corpus_version || "?")}</code></p></div>`);
}

async function call(target, options, button) {
  button.disabled = true;
  $("out").innerHTML = `<div class="card"><span class="note">Asking…</span></div>`;
  try {
    const r = await fetch(target, options);
    const j = await r.json();
    if (j.error) {
      $("out").innerHTML = `<div class="card"><div class="banner bad"><div class="title">${esc(j.error.code)}</div>
        <div class="note">${esc(j.error.message)}</div></div></div>`;
    } else if (j.hits) {
      $("out").innerHTML = `<div class="card"><h2><span class="n">6</span>What the search found (no model)</h2>${candidates(j.hits)}</div>`;
    } else if (j.rows) {
      published(j);
    } else {
      render(j);
    }
  } catch (e) {
    $("out").innerHTML = `<div class="card"><div class="banner bad"><div class="title">The service did not answer</div>
      <div class="note">${esc(e.message)}</div></div></div>`;
  } finally {
    button.disabled = false;
  }
}

$("build").onclick = (e) =>
  call(url("/internal/rag/evidence?" + params() + "&gate_at=" + encodeURIComponent(gateAt())), { method: "POST" }, e.target);
$("look").onclick = (e) => {
  const q = mode() === "question" ? $("free").value.trim() : $("description").value.trim();
  call(url("/internal/rag/search?q=" + encodeURIComponent(q || "limitação")
    + "&published_before=" + encodeURIComponent(gateAt())), {}, e.target);
};
// The table apps/api reads. No model runs, so this answers even when the free
// tier has nothing left this minute.
$("stored").onclick = (e) => call(
  url(`/internal/rag/evidence?subsystem=${$("subsystem").value}&target_date=${$("date").value}&limit=10`),
  {}, e.target);

for (const el of ["subsystem", "date", "reason", "description", "free"]) $(el).oninput = preview;
// An edited field is no longer the picked record, so the picker stops naming it.
for (const el of ["reason", "description"]) $(el).addEventListener("input", () => { $("sample").selectedIndex = -1; });
for (const el of document.querySelectorAll("input[name=mode]")) el.onchange = preview;
$("sample").onchange = (e) => fill(e.target.value);

RECORDS.forEach((r, i) => {
  const o = document.createElement("option");
  o.value = i;
  o.textContent = `${r.date} · ${r.subsystem} · ${r.reason || "no reason"} · ${r.description.slice(0, 80)}`;
  $("sample").appendChild(o);
});
if (!RECORDS.length) {
  const o = document.createElement("option");
  o.textContent = "no evaluation set built: type a description below";
  $("sample").appendChild(o);
  $("date").value = new Date().toISOString().slice(0, 10);
  preview();
} else {
  fill(0);
}

(async () => {
  try {
    const [s, q] = await Promise.all([
      fetch(url("/internal/rag/status")).then((r) => r.json()),
      fetch(url("/internal/llm/quota")).then((r) => r.json()),
    ]);
    const keys = Object.entries(q.providers || {})
      .map(([name, v]) => `${name}: ${v.keys} key(s)${v.enabled ? "" : ", disabled"}`).join(" · ");
    const documents = (s.sources || []).reduce((total, row) => total + row.documents, 0);
    $("status").textContent =
      `Collection: ${documents} ONS documents, ${s.chunks?.total ?? "?"} passages (${s.chunks?.embedded ?? "?"} searchable by meaning)`
      + ` · ${s.evidence?.total ?? 0} answers stored` + (keys ? ` · providers: ${keys}` : "")
      + `\\ncorpus ${s.corpus_version || "?"}`;
  } catch { $("status").textContent = "The service is up but did not report its collection."; }
})();
</script>
</body>
</html>
"""


def page() -> str:
    return PAGE.replace("__RECORDS__", json.dumps(sample_records(), ensure_ascii=False))
