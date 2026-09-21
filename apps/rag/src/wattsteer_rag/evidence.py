"""Draft claims against the corpus, gate them, review them and persist them.

The loop: turn a curtailment record into a question, retrieve the chunks that
could answer it, ask the gateway for claims, put every claim through the
mechanical gates in `gate.py`, retry once with the spans it should have quoted,
read the survivors with the smaller model in `verify.py`, and write what is
left.

The gates themselves are not here. They are pure functions of a claim and its
chunks, and they live in `gate.py`, which this module imports and never
reaches around. What is here is everything the gates are not: the gateway, the
retry, the budget, the clock and the database.

When nothing survives, the answer is a refusal with a reason, never a softer
claim. The failure mode of this service is silence.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime
from typing import Any

from .db import Database
from .gate import GateFailure, Record, check_claim, numbers_in, quotable_spans
from .gateway.router import Gateway, QuotaExhausted
from .retrieve import Hit, codes_in, search
from .verify import ReaderUnavailable, review

SCHEMA_VERSION = "1.0"
MAX_ITEMS = 12


# The documents are Portuguese and the quotes are literal copies of them, so the
# claims are written in Portuguese too: that is the language of the operator who
# reads them and of the judges who check them against the PDF.
SYSTEM_PROMPT = """You retrieve documentary evidence from the public record of the ONS, the
Brazilian power system operator. The passages are in Portuguese. Write every
claim in Portuguese.

Absolute rules:
- Use only the passages provided. Do not use your own knowledge.
- Every claim needs at least one citation, and the citation must be a span
  copied literally from the document, between 20 and 600 characters. In a
  paragraph, copy the whole sentence that states the value, from its subject
  to its number.
- Do not write any number that does not appear in the quoted span.
- Describe what the document records or establishes. Never write that something
  caused, provoked or explained something else.
- If the passages support no claim, return an empty list.

Prefer the span that states the procedure, the limit or the condition, with its
values and quantities. A section title on its own is not evidence.

Each claim answers the question. When the passages give the value the question
asks for, the claim states that value; the preamble of a procedure step ("remanejar
a geração nas usinas definidas na tabela abaixo") without the value from its table
is not an answer. Names in tables may be misspelled by the scan (Tucaratu for
Tacaratu): a row is about the place the question names when the rest of the row
and its section say so.

Many passages are tables. There, every citation must be a contiguous piece: a
whole row, or a run of neighbouring rows, copied in the order they appear. Do
not join a cell from the beginning with one from the end. If you need two
distinct parts of the table, use two citations in the same item.

Answer only with JSON in this shape:
{"items":[{"claim":"...","supports":"REL|CNF|ENE|NONE","confidence":"high|medium|low",
"citations":[{"chunk_id":"...","quote":"..."}]}]}"""


def question_for(subsystem: str, date: str, reason: str | None, description: str | None) -> str:
    """Turn a curtailment record into the question the corpus can answer.

    The ONS already declares the reason and names the control it applied, often
    with the code of the operating instruction. The job is not to guess the
    reason: it is to find where that control is written down.
    """
    # Portuguese on purpose: this text is the full text query against a
    # Portuguese index, and the words it carries are the words the corpus uses.
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
    record = Record.of(question, description, target_date)
    hits = await search(
        db,
        gateway,
        question,
        published_before=gate_at,
        named_documents=list(record.named_documents) or None,
        target_date=target_date,
    )
    document = _empty_document(subsystem, target_date, gate_at, question, trace_id, hits)
    document["corpus_version"] = await db.corpus_version()
    if hits:
        await _draft(gateway, document, record, hits)
    else:
        document["reason"] = "corpus_no_coverage_for_date"
    await _persist(db, document, gateway, trace_id)
    return document


def _empty_document(
    subsystem: str, target_date: str, gate_at: datetime, question: str, trace_id: str, hits: list[Hit]
) -> dict[str, Any]:
    return {
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
        "corpus_version": "",
        "generated_at": datetime.now(UTC).isoformat(),
        "trace": {
            "trace_id": trace_id,
            "retrieval": {
                "hybrid_candidates": len(hits),
                "reranked": len(hits),
                "rerank_provider": None,
                "filters": {"published_before": gate_at.isoformat()},
                "candidates": [_candidate(hit) for hit in hits],
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


def _candidate(hit: Hit) -> dict:
    return {
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


def _passage(hit: Hit) -> str:
    document = f"{hit.external_id or hit.source} {hit.revision or ''}".strip()
    published = hit.published_at.date().isoformat() if hit.published_at else "on an undeclared date"
    # Both: a daily report names its submarket only in the section heading
    # ("Submercado Sul:"), lines above the sentence that states the reduction,
    # and a header with the page alone hid which submarket the passage is about.
    where = ", ".join(
        part
        for part in (f"page {hit.locator['page']}" if hit.locator.get("page") else "", hit.section_path or "")
        if part
    )
    header = f"Document: {hit.title} ({document}), published {published}, {where}"
    return f"[chunk_id: {hit.chunk_id}]\n{header}\n{hit.text[:2200]}"


def _guidance(hits: list[Hit]) -> str:
    """Spans that would pass the quote gate if copied. Offered only after a
    refusal: on the first attempt they nudge the model into quoting the sample
    instead of reading the document, and the point is the document."""
    spans = "\n".join(
        f'- [{hit.chunk_id}] "{span}"' for hit in hits[:3] for span in quotable_spans(hit.text)[:2]
    )
    if not spans:
        return ""
    return "\n\nContiguous spans that exist in the documents and can be copied as citations:\n" + spans


def _complaint(guidance: str, failures: list[GateFailure]) -> str:
    refused = "; ".join(f"{failure.code} ({failure.detail})" for failure in failures[:4])
    return (
        f"{guidance}\n\nThe previous answer was refused on these points: {refused}."
        " Rules for the new attempt: copy the contiguous span exactly as it appears"
        " above, including inside the span every number you cite in the claim; use only"
        " the chunk_id values listed; if the span is inside a table, copy the cells'"
        " content in sequence, without inventing punctuation."
    )


async def _draft(gateway: Gateway, document: dict, record: Record, hits: list[Hit]) -> None:
    """Ask the model, gate the answer, retry with the refusals, settle the verdict."""
    by_chunk = {hit.chunk_id: hit for hit in hits}
    passages = "\n\n".join(_passage(hit) for hit in hits)
    guidance = _guidance(hits)
    generation = document["trace"]["generation"]
    complaint = ""
    accepted: list[dict] = []
    failures: list[GateFailure] = []
    for attempt in (1, 2, 3):
        result = await _generate(gateway, document, record, passages + complaint, attempt, failures)
        if result is None:
            return
        accepted, failures = _gate_answer(result.value, by_chunk, attempt, generation, record)
        try:
            accepted = await _reviewed(gateway, record, accepted, attempt, generation, failures)
        except ReaderUnavailable as exc:
            # Every retry would be refused the same way; stop spending drafts.
            _stop(document, failures, "claim_reader_unavailable")
            generation["claim_reader"] = f"unavailable: {exc}"
            return
        if accepted:
            break
        complaint = _complaint(guidance, failures)
    generation["gate_failures"] = sorted({failure.code for failure in failures})
    _settle(document, accepted, record.question)


async def _generate(
    gateway: Gateway, document: dict, record: Record, passages: str, attempt: int, failures: list[GateFailure]
):
    """One draft from the model, or None once the quota has settled the document."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Question: {record.question}\n\nAvailable passages:\n\n{passages}"},
    ]
    try:
        result = await gateway.run(
            "generate_strong", tokens=max(1, len(passages) // 4), messages=messages, want_json=True
        )
    except QuotaExhausted as exc:
        # Running out on the first attempt and running out after the gates
        # refused two drafts are different problems, and only the first is
        # solved by waiting. Saying "no quota" about a run that was actually
        # refused sends the reader to the provider's dashboard instead of to
        # the gate that rejected the claim.
        _stop(
            document, failures, "quota_exhausted_before_answer" if attempt == 1 else "quota_exhausted_partial"
        )
        document["trace"]["generation"]["attempts"] = attempt - 1
        document["trace"]["retry_at"] = exc.retry_at
        return None
    document["trace"]["generation"].update(
        {"provider": result.provider, "model": result.model, "attempts": attempt, "source": "model"}
    )
    return result


def _stop(document: dict, failures: list[GateFailure], reason: str) -> None:
    document["verdict"], document["reason"] = "insufficient", reason
    document["trace"]["generation"]["gate_failures"] = sorted({failure.code for failure in failures})


async def _reviewed(
    gateway: Gateway,
    record: Record,
    accepted: list[dict],
    attempt: int,
    generation: dict,
    failures: list[GateFailure],
) -> list[dict]:
    """The claims a second reader agrees the quotes state. See `verify.py`."""
    kept: list[dict] = []
    for claim in accepted:
        supported, reason = await review(gateway, record.question, claim)
        if supported:
            kept.append(claim)
            continue
        failure = GateFailure("quote_does_not_state_claim", reason)
        failures.append(failure)
        generation.setdefault("rejected", []).append(_rejected(claim, [failure], attempt))
    return kept


def _gate_answer(
    value: Any, by_chunk: dict[str, Hit], attempt: int, generation: dict, record: Record
) -> tuple[list[dict], list[GateFailure]]:
    payload = value if isinstance(value, dict) else {"items": value}
    accepted: list[dict] = []
    failures: list[GateFailure] = []
    rejected: list[dict] = []
    for item in (payload.get("items") or [])[:MAX_ITEMS]:
        claim, item_failures = check_claim(item, by_chunk, record)
        failures.extend(item_failures)
        if claim:
            accepted.append(claim)
        else:
            rejected.append(_rejected(item, item_failures, attempt))
    # Keeping what the model tried to say, and why it was refused, is the
    # difference between "the RAG found nothing" and knowing which gate to argue with.
    generation.setdefault("rejected", []).extend(rejected)
    return accepted, failures


def _rejected(item: Any, failures: list[GateFailure], attempt: int) -> dict:
    item = item if isinstance(item, dict) else {}
    citations = [c for c in (item.get("citations") or []) if isinstance(c, dict)]
    return {
        "claim": str(item.get("claim") or "")[:300],
        "supports": item.get("supports"),
        "cited_chunks": [c.get("chunk_id") for c in citations],
        "quotes": [str(c.get("quote") or "")[:160] for c in citations],
        "failures": [{"code": f.code, "detail": f.detail} for f in failures],
        "attempt": attempt,
    }


SUPPORT_ORDER = {"REL": 0, "CNF": 1, "ENE": 2, "NONE": 3}


def _settle(document: dict, accepted: list[dict], restated: str = "") -> None:
    if not accepted:
        document["verdict"] = "insufficient"
        document["reason"] = "gates_rejected_all_claims"
        return
    accepted.sort(key=lambda claim: (SUPPORT_ORDER[claim["supports"]], -claim["evidence_weight"]))
    document["items"] = accepted
    document["verdict"] = "found"
    # The same rule the gate applies, so that whoever narrates this downstream
    # refuses exactly what was refused here: numbers from the quoted text and
    # from the cited item ("6.2.1"), plus the ones the record itself stated.
    document["numbers_whitelist"] = sorted(
        {
            number
            for claim in accepted
            for citation in claim["citations"]
            for number in numbers_in(f"{citation['quote']} {citation['locator'].get('section') or ''}")
        }
        | set(numbers_in(restated))
    )


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
