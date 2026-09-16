"""The evidence builder and its gates.

The model writes claims; the gates decide whether a claim is allowed to exist.
Three of them, and all three are mechanical:

1. Every quote must appear in the chunk it cites, character for character once
   whitespace is normalised. A quote that cannot be found is an invention.
2. Every number in a claim must appear in one of that claim's quotes. This is
   the same rule the narration already enforces on the forecast card.
3. No causal vocabulary. The record says what was scheduled or what was
   registered. It never says what caused what: that reading belongs to the rule
   and to SHAP, not to a retrieved paragraph.

When nothing survives, the answer is a refusal with a reason, never a softer
claim. The failure mode of this service is silence.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from .db import Database
from .gateway.router import Gateway, QuotaExhausted
from .retrieve import Hit, codes_in, search

SCHEMA_VERSION = "1.0"

# Ported from packages/core/src/causality.ts so both sides ban the same words.
CAUSALITY_BANNED_LEMMAS = (
    "causal",
    "causality",
    "causal ai",
    "root cause",
    "caused by",
    "causes the",
    "because the grid",
    "why it happened",
    "driver of the event",
    "causa",
    "causou",
    "causado por",
    "causada por",
    "causa raiz",
    "porque ocorreu",
)

NUMBER = re.compile(r"\d[\d.,]*")
WORD_BOUNDARY = re.compile(r"[^\wÀ-ÿ]+")

SYSTEM_PROMPT = """Você recupera evidência documental do registro público do ONS.

Regras absolutas:
- Use somente os trechos fornecidos. Não use conhecimento próprio.
- Cada afirmação precisa de pelo menos uma citação, e a citação tem de ser um
  trecho copiado literalmente do documento, entre 20 e 300 caracteres.
- Não escreva nenhum número que não apareça no trecho citado.
- Descreva o que o documento registra ou estabelece. Nunca escreva que algo
  causou, provocou ou explicou outra coisa.
- Se os trechos não sustentarem nenhuma afirmação, devolva a lista vazia.

Prefira o trecho que enuncia o procedimento, o limite ou a condição, com os
valores e as grandezas. Um título de seção sozinho não é evidência.

Muitos trechos são tabelas. Nelas, cada citação tem de ser um pedaço contínuo:
uma linha inteira ou uma sequência de linhas vizinhas, copiadas na ordem em que
aparecem. Não junte uma célula do começo com outra do fim. Se precisar de duas
partes distintas da tabela, use duas citações no mesmo item.

Responda apenas com JSON no formato:
{"items":[{"claim":"...","supports":"REL|CNF|ENE|NONE","confidence":"high|medium|low",
"citations":[{"chunk_id":"...","quote":"..."}]}]}"""


@dataclass
class GateFailure:
    code: str
    detail: str


def normalise(text: str) -> str:
    """Whitespace and typography vary between the PDF and the model's copy."""
    text = unicodedata.normalize("NFKC", text or "")
    text = text.replace("\u00ad", "").replace("\u2019", "'").replace("\u2013", "-").replace("\u2014", "-")
    return re.sub(r"\s+", " ", text).strip().lower()


TABLE_NOISE = re.compile(r"\\(?:multirow|multicolumn)\{[^}]*\}(?:\{[^}]*\})?|[|}{]|(?:^|\s)-{3,}(?=\s|$)")


def flatten_for_match(text: str) -> str:
    """Compare on the words, not on the table syntax.

    An operating instruction states its limits inside a six column table, so the
    parser stores a row as `| 1 | COSR-NE | ... | PSNB <= 260 MW |`. A model
    reading that table quotes the sentence, not the pipes. Dropping the table
    scaffolding from both sides keeps the check strict about the words and their
    order, which is what "this text exists in the document" means, while not
    failing over a delimiter the document never had.
    """
    return re.sub(r"\s+", " ", TABLE_NOISE.sub(" ", normalise(text))).strip()


def numbers_in(text: str) -> list[str]:
    return [match.group(0).strip(".,") for match in NUMBER.finditer(text or "")]


def _number_key(number: str) -> str:
    """1.200 and 1200 are the same quantity; 26 and 260 are not."""
    digits = re.sub(r"[.,]", "", number.strip())
    return digits.lstrip("0") or "0"


HEADING = re.compile(r"^\s*\d+(\.\d+)*\.?\s")


def assembled_match(quote: str, chunk_text: str, *, max_fragments: int = 8) -> bool:
    """Does this quote come from the cells of this table, in this order?

    In a table the evidence a person would point at is a cell plus the row that
    carries the numbers, and the rows in between are other columns. Demanding a
    contiguous span there means refusing every true citation from a table, which
    is most of what an operating instruction is made of.

    The rule stays strict in the ways that matter: every fragment has to exist in
    the chunk, and the fragments have to appear in the same order as in the
    document. Nothing can be invented and nothing can be re-ordered to change
    what the table says. A citation accepted this way is marked `assembled`, so
    the screen can say that cells were skipped.
    """
    haystack = flatten_for_match(chunk_text)
    fragments = [
        flatten_for_match(fragment)
        for fragment in re.split(r"\|+|\s{3,}", quote)
        if len(flatten_for_match(fragment)) >= 3
    ]
    if not fragments or len(fragments) > max_fragments:
        return False
    cursor = 0
    for fragment in fragments:
        found = haystack.find(fragment, cursor)
        if found == -1:
            return False
        cursor = found + len(fragment)
    return True


def has_substance(quote: str) -> bool:
    """Is this a statement, or just a heading that happens to match the query?"""
    stripped = quote.strip()
    words = len(re.findall(r"[\wÀ-ÿ]+", stripped))
    if HEADING.match(stripped) and words <= 10:
        return False
    return words >= 8 or bool(re.search(r"\d", stripped))


def causal_hits(text: str) -> list[str]:
    haystack = f" {WORD_BOUNDARY.sub(' ', normalise(text))} "
    return [lemma for lemma in CAUSALITY_BANNED_LEMMAS if f" {lemma} " in haystack]


def check_claim(item: Any, by_chunk: dict[str, Hit]) -> tuple[dict | None, list[GateFailure]]:
    """Run the gates. Returns the accepted claim, or the reasons it failed.

    The model's output is untrusted input: a string where an object was asked
    for is a rejected claim, never an exception.
    """
    failures: list[GateFailure] = []
    if not isinstance(item, dict):
        return None, [GateFailure("schema_invalid", f"item is {type(item).__name__}")]
    claim = (item.get("claim") or "").strip() if isinstance(item.get("claim"), str) else ""
    if len(claim) < 10:
        return None, [GateFailure("schema_invalid", "claim too short")]

    accepted_citations = []
    citations = item.get("citations")
    if not isinstance(citations, list):
        return None, [GateFailure("schema_invalid", "citations is not a list")]
    for citation in citations:
        if not isinstance(citation, dict):
            failures.append(GateFailure("schema_invalid", f"citation is {type(citation).__name__}"))
            continue
        chunk_id = str(citation.get("chunk_id") or "")
        quote = citation.get("quote")
        quote = quote.strip() if isinstance(quote, str) else ""
        hit = by_chunk.get(chunk_id)
        if hit is None:
            failures.append(GateFailure("quote_not_in_chunk", f"unknown chunk {chunk_id[:8]}"))
            continue
        assembled = False
        if len(quote) < 20:
            failures.append(GateFailure("quote_not_in_chunk", f"quote too short for {chunk_id[:8]}"))
            continue
        if flatten_for_match(quote) not in flatten_for_match(hit.text):
            is_table = bool((hit.locator or {}).get("table")) or hit.text.lstrip().startswith("|")
            if not (is_table and assembled_match(quote, hit.text)):
                failures.append(GateFailure("quote_not_in_chunk", f"quote absent from {chunk_id[:8]}"))
                continue
            assembled = True
        if not has_substance(quote):
            # A section title quoted on its own proves the section exists and
            # nothing else. The operator needs the sentence that states the rule.
            failures.append(GateFailure("quote_without_substance", quote[:60]))
            continue
        locator = dict(hit.locator or {})
        if not any(locator.get(key) for key in ("page", "section", "table")):
            failures.append(GateFailure("locator_missing", chunk_id[:8]))
            continue
        accepted_citations.append(
            {
                "document_id": hit.document_id,
                "source": hit.source,
                "title": hit.title,
                "published_at": hit.published_at.isoformat() if hit.published_at else None,
                "locator": {
                    "page": locator.get("page"),
                    "section": locator.get("section") or hit.section_path,
                    "table": locator.get("table"),
                    "row": locator.get("row"),
                },
                "quote": quote[:300],
                "assembled": assembled,
                "url": hit.url,
                "sha256": hit.sha256,
                "chunk_id": chunk_id,
                "external_id": hit.external_id,
                "revision": hit.revision,
            }
        )

    if not accepted_citations:
        return None, failures or [GateFailure("quote_not_in_chunk", "no citation survived")]

    quoted_numbers = {
        _number_key(number) for citation in accepted_citations for number in numbers_in(citation["quote"])
    }
    for number in numbers_in(claim):
        # Token comparison, not substring: a claim saying 26 must not be accepted
        # because the quote happens to contain 260.
        if _number_key(number) not in quoted_numbers:
            failures.append(GateFailure("number_not_in_quote", number))
    if any(failure.code == "number_not_in_quote" for failure in failures):
        return None, failures

    hits = causal_hits(claim)
    if hits:
        return None, [*failures, GateFailure("causal_vocabulary", ", ".join(hits))]

    supports = (item.get("supports") or "NONE").upper()
    if supports not in {"REL", "CNF", "ENE", "NONE"}:
        supports = "NONE"
    confidence = (item.get("confidence") or "low").lower()
    if confidence not in {"high", "medium", "low"}:
        confidence = "low"
    # REL without a published intervention schedule can never be high: the
    # document that would settle it is not public (D09).
    if supports == "REL" and confidence == "high":
        confidence = "medium"

    return (
        {
            "claim": claim[:400],
            "supports": supports,
            "confidence": confidence,
            "evidence_weight": EVIDENCE_WEIGHT[supports],
            "period": None,
            "citations": accepted_citations[:4],
        },
        failures,
    )


EVIDENCE_WEIGHT = {"REL": 0.8, "CNF": 0.5, "ENE": 0.3, "NONE": 0.0}


def quotable_spans(text: str, *, minimum: int = 60, maximum: int = 280) -> list[str]:
    """Spans of a chunk that would pass the quote gate if copied.

    The model keeps stitching cells from opposite ends of a table, which the gate
    correctly refuses. Handing it spans that are already contiguous turns a retry
    into a copy instead of another guess, and every span here comes from the
    chunk itself, so nothing is being put in the model's mouth.
    """
    spans: list[str] = []
    for line in text.split("\n"):
        cleaned = " ".join(
            part.strip() for part in line.split("|") if part.strip() and set(part.strip()) != {"-"}
        )
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if minimum <= len(cleaned) <= maximum:
            spans.append(cleaned)
    spans.sort(key=lambda span: (-len(re.findall(r"\d", span)), -len(span)))
    return spans


def question_for(subsystem: str, date: str, reason: str | None, description: str | None) -> str:
    """Turn a curtailment record into the question the corpus can answer.

    The ONS already declares the reason and names the control it applied, often
    with the code of the operating instruction. The job is not to guess the
    reason: it is to find where that control is written down.
    """
    parts = [f"Subsistema {subsystem}, dia {date}."]
    if description:
        parts.append(f"Registro do ONS: {description}")
        codes = codes_in(description)
        if codes:
            parts.append("Documentos citados: " + ", ".join(codes) + ".")
    if reason:
        parts.append(f"Razão declarada: {reason}.")
    parts.append("Onde está estabelecido esse limite ou procedimento, e o que o documento diz?")
    return " ".join(parts)


async def build_evidence(
    db: Database,
    gateway: Gateway,
    *,
    subsystem: str,
    target_date: str,
    gate_at: datetime,
    reason: str | None = None,
    description: str | None = None,
    question: str | None = None,
    trace_id: str | None = None,
) -> dict:
    """Retrieve, ask, gate, and return a RagEvidence document."""
    question = question or question_for(subsystem, target_date, reason, description)
    trace_id = trace_id or hashlib.sha256(f"{subsystem}{target_date}{question}".encode()).hexdigest()[:12]

    hits = await search(db, gateway, question, published_before=gate_at)
    by_chunk = {hit.chunk_id: hit for hit in hits}
    rerank_provider = None
    candidates = [
        {
            "chunk_id": hit.chunk_id,
            "document": f"{hit.external_id or hit.source} {hit.revision or ''}".strip(),
            "title": hit.title[:80],
            "published_at": hit.published_at.date().isoformat() if hit.published_at else None,
            "locator": hit.locator,
            "vector_rank": hit.vector_rank,
            "text_rank": hit.text_rank,
            "rrf": round(hit.score, 5),
            "preview": hit.text[:160].replace("\n", " "),
        }
        for hit in hits
    ]

    document: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "subsystem": subsystem,
        "target_date": target_date,
        "gate_at": gate_at.isoformat(),
        "question": question[:600],
        "verdict": "not_found",
        "reason": None,
        "items": [],
        "rule_disagreement": None,
        "numbers_whitelist": [],
        "corpus_version": await db.corpus_version(),
        "generated_at": datetime.now(UTC).isoformat(),
        "trace": {
            "trace_id": trace_id,
            "retrieval": {
                "hybrid_candidates": len(hits),
                "reranked": len(hits),
                "rerank_provider": rerank_provider,
                "filters": {"published_before": gate_at.isoformat()},
                "candidates": candidates,
            },
            "generation": {
                "provider": None,
                "model": None,
                "attempts": 0,
                "source": "none",
                "gate_failures": [],
            },
        },
    }

    if not hits:
        document["reason"] = "corpus_no_coverage_for_date"
        await _persist(db, document, gateway, trace_id)
        return document

    passages = "\n\n".join(
        f"[chunk_id: {hit.chunk_id}]\n"
        f"Documento: {hit.title} ({hit.external_id or hit.source}{' ' + hit.revision if hit.revision else ''}),"
        f" publicado em {hit.published_at.date().isoformat() if hit.published_at else 'data não declarada'},"
        f" {('página ' + str(hit.locator.get('page'))) if hit.locator.get('page') else hit.section_path or ''}\n"
        f"{hit.text[:2200]}"
        for hit in hits
    )

    # Spans that would pass the quote gate if copied. Offered only after a
    # refusal: on the first attempt they nudge the model into quoting the sample
    # instead of reading the document, and the point is the document.
    spans = "\n".join(
        f'- [{hit.chunk_id}] "{span}"' for hit in hits[:3] for span in quotable_spans(hit.text)[:2]
    )
    guidance = (
        "\n\nTrechos contínuos que existem nos documentos e podem ser copiados como citação:\n" + spans
        if spans
        else ""
    )
    complaint = ""
    accepted: list[dict] = []
    failures: list[GateFailure] = []
    for attempt in (1, 2, 3):
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"Pergunta: {question}\n\nTrechos disponíveis:\n\n{passages}{complaint}",
            },
        ]
        try:
            result = await gateway.run(
                "generate_strong",
                tokens=max(1, len(passages) // 4),
                messages=messages,
                want_json=True,
            )
        except QuotaExhausted as exc:
            document["verdict"] = "insufficient"
            document["reason"] = "quota_exhausted_partial"
            document["trace"]["generation"]["attempts"] = attempt - 1
            document["trace"]["retry_at"] = exc.retry_at
            await _persist(db, document, gateway, trace_id)
            return document

        document["trace"]["generation"].update(
            {
                "provider": result.provider,
                "model": result.model,
                "attempts": attempt,
                "source": "model",
            }
        )
        payload = result.value if isinstance(result.value, dict) else {"items": result.value}
        accepted, failures = [], []
        rejected: list[dict] = []
        for item in (payload.get("items") or [])[:12]:
            claim, item_failures = check_claim(item, by_chunk)
            failures.extend(item_failures)
            if claim:
                accepted.append(claim)
            else:
                # Keeping what the model tried to say, and why it was refused, is
                # the difference between "the RAG found nothing" and knowing which
                # of the three gates to argue with.
                rejected.append(
                    {
                        "claim": (item.get("claim") or "")[:300],
                        "supports": item.get("supports"),
                        "cited_chunks": [c.get("chunk_id") for c in (item.get("citations") or [])],
                        "quotes": [(c.get("quote") or "")[:160] for c in (item.get("citations") or [])],
                        "failures": [{"code": f.code, "detail": f.detail} for f in item_failures],
                        "attempt": attempt,
                    }
                )
        document["trace"]["generation"].setdefault("rejected", []).extend(rejected)
        if accepted or attempt == 3:
            break
        complaint = (
            guidance
            + "\n\nA resposta anterior foi recusada nestes pontos: "
            + "; ".join(f"{failure.code} ({failure.detail})" for failure in failures[:4])
            + ". Regras para a nova tentativa: copie o trecho contínuo exatamente como aparece"
            " acima, incluindo dentro do trecho todos os números que você citar na afirmação;"
            " use apenas os chunk_id listados; se o trecho estiver dentro de uma tabela, copie"
            " o conteúdo das células em sequência, sem inventar pontuação."
        )

    document["trace"]["generation"]["gate_failures"] = sorted({failure.code for failure in failures})
    if accepted:
        order = {"REL": 0, "CNF": 1, "ENE": 2, "NONE": 3}
        accepted.sort(key=lambda claim: (order[claim["supports"]], -claim["evidence_weight"]))
        document["items"] = accepted
        document["verdict"] = "found"
        document["numbers_whitelist"] = sorted(
            {
                number
                for claim in accepted
                for citation in claim["citations"]
                for number in numbers_in(citation["quote"])
            }
        )
    else:
        document["verdict"] = "insufficient"
        document["reason"] = "gates_rejected_all_claims"

    await _persist(db, document, gateway, trace_id)
    return document


async def _persist(db: Database, document: dict, gateway: Gateway, trace_id: str) -> None:
    payload = json.dumps(document, ensure_ascii=False, sort_keys=True)
    digest = hashlib.sha256(payload.encode()).hexdigest()
    question_key = hashlib.sha256(document["question"].encode()).hexdigest()[:16]
    target_date = date.fromisoformat(document["target_date"])
    gate_at = datetime.fromisoformat(document["gate_at"])
    pool = await db.connect()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO rag.evidence (subsystem, target_date, question_key, gate_at, verdict, reason,"
            " payload, corpus_version, sha256) VALUES ($1,$2::date,$3,$4::timestamptz,$5,$6,$7::jsonb,$8,$9)"
            # Published, not overwritten: a different answer to the same question
            # is a new row, so a replay can still find what was served on the day.
            " ON CONFLICT ON CONSTRAINT evidence_identity DO NOTHING",
            document["subsystem"],
            target_date,
            question_key,
            gate_at,
            document["verdict"],
            document["reason"],
            document,
            document["corpus_version"],
            digest,
        )
        await conn.execute(
            "INSERT INTO rag.retrieval_log (question, filters, chunk_ids, scores, trace_id)"
            " VALUES ($1,$2::jsonb,$3::uuid[],$4,$5)",
            document["question"],
            document["trace"]["retrieval"]["filters"],
            [citation["chunk_id"] for claim in document["items"] for citation in claim["citations"]],
            [claim["evidence_weight"] for claim in document["items"]],
            trace_id,
        )
    await db.log_calls(gateway.calls[-8:], trace_id)
    document["sha256"] = digest
