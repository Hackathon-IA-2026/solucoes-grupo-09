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
MAX_QUOTE_CHARS = 600

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


def _is_title_line(line: str) -> bool:
    """A numbered line that is a title, not a numbered clause.

    Both start with "5.1.". The operating instructions write their titles in
    capitals and their rules in sentences, and that is the difference a reader
    uses too.
    """
    if line.startswith("#"):
        return True
    body = line.lstrip("#").strip()
    if not HEADING.match(body):
        return False
    letters = [char for char in body if char.isalpha()]
    return bool(letters) and sum(char.isupper() for char in letters) / len(letters) >= 0.8


def has_substance(quote: str) -> bool:
    """Is this a statement, or just a heading that happens to match the query?"""
    stripped = quote.strip()
    # A section title is not evidence however long it is, and stacking two of
    # them does not make a sentence. "5. LIMITACOES DA TRANSMISSAO" followed by
    # "5.1. LIMITACAO DA TRANSMISSAO NAS LTS 500 KV ACU III / QUIXADA" names the
    # limit the record is about and states none of it, which is exactly the
    # answer that looks right and proves nothing.
    lines = [line.strip() for line in stripped.split("\n") if line.strip()]
    if lines and all(_is_title_line(line) for line in lines):
        return False
    words = len(re.findall(r"[\wÀ-ÿ]+", stripped))
    if HEADING.match(stripped) and words <= 10:
        return False
    return words >= 8 or bool(re.search(r"\d", stripped))


def causal_hits(text: str) -> list[str]:
    haystack = f" {WORD_BOUNDARY.sub(' ', normalise(text))} "
    return [lemma for lemma in CAUSALITY_BANNED_LEMMAS if f" {lemma} " in haystack]


EVIDENCE_WEIGHT = {"REL": 0.8, "CNF": 0.5, "ENE": 0.3, "NONE": 0.0}
CONFIDENCES = {"high", "medium", "low"}
MAX_ITEMS = 12
MAX_CITATIONS = 4


DOCUMENT_CODE = re.compile(r"^(?:IO|IT|RT|NT)-", re.I)


@dataclass(frozen=True)
class Record:
    """What the ONS published, as far as the gates are concerned.

    A quote can be literal, substantial and located, and still be evidence for
    something else. The record is what tells the difference.
    """

    question: str = ""
    named_documents: tuple[str, ...] = ()
    target_date: str | None = None

    @classmethod
    def of(cls, question: str, description: str | None, target_date: str | None) -> Record:
        # `codes_in` also returns the line and the intervention number, which are
        # things to search for, not documents to open.
        return cls(
            question=question,
            named_documents=tuple(code for code in codes_in(description or "") if DOCUMENT_CODE.match(code)),
            target_date=target_date,
        )


# The bulletins published every day, and which days after the reported one
# each may carry: the BDO is dated the day it reports; the preliminary IPDO is
# published the morning after.
DAILY_REPORTS = {"BDO": (0,), "IPDO": (0, 1)}


def _relevance_failure(hit: Hit, record: Record) -> GateFailure | None:
    """Is this document about the record at all?

    Two ways a perfectly literal quote is still the wrong evidence, both seen in
    a measured run:

    The record names an operating instruction and the answer quotes a different
    one. IO-ON.NE.2LE and IO-ON.NE.5NE describe neighbouring areas in the same
    words, so the quote reads right and points at the wrong area of the grid.

    The answer quotes the disturbance report of 15/08/2023 to explain a flow
    control of August 2026. A report analyses one event on one date, and outside
    that date it supports nothing.

    The same holds for the daily bulletins, and it was measured: with the
    record's own instruction out of the corpus, a restriction of 13/12/2025 was
    "explained" by the IPDO of 07/09/2025 about another transformer, with high
    confidence. A BDO speaks for its own date only; an IPDO, published the next
    morning, also for the day before it.
    """
    if (
        hit.source == "INSTRUCAO_OPERACAO"
        and record.named_documents
        and hit.external_id not in record.named_documents
    ):
        return GateFailure(
            "citation_not_the_named_document",
            f"{hit.external_id} for a record naming {', '.join(record.named_documents)}",
        )
    if hit.source == "RAP" and record.target_date and hit.published_at:
        if hit.published_at.date().isoformat() != record.target_date:
            return GateFailure(
                "citation_from_another_event",
                f"{hit.external_id} analyses {hit.published_at.date()}, record is {record.target_date}",
            )
    if hit.source in DAILY_REPORTS and record.target_date and hit.published_at:
        days_after = (hit.published_at.date() - date.fromisoformat(record.target_date)).days
        if days_after not in DAILY_REPORTS[hit.source]:
            return GateFailure(
                "citation_from_another_day",
                f"{hit.external_id} reports {hit.published_at.date()}, record is {record.target_date}",
            )
    return None


def _is_table(hit: Hit) -> bool:
    return bool((hit.locator or {}).get("table")) or hit.text.lstrip().startswith("|")


def _check_citation(
    citation: Any, by_chunk: dict[str, Hit], record: Record
) -> tuple[dict | None, GateFailure | None]:
    """One citation through the quote gates: exists, says something, can be located."""
    if not isinstance(citation, dict):
        return None, GateFailure("schema_invalid", f"citation is {type(citation).__name__}")
    chunk_id, quote = _citation_shape(citation)
    hit = by_chunk.get(chunk_id)
    if hit is None:
        return None, GateFailure("quote_not_in_chunk", f"unknown chunk {chunk_id[:8]}")
    off_topic = _relevance_failure(hit, record)
    if off_topic:
        return None, off_topic
    if len(quote) < 20:
        return None, GateFailure("quote_not_in_chunk", f"quote too short for {chunk_id[:8]}")
    assembled = _quote_is_assembled(quote, hit)
    if assembled is None:
        return None, GateFailure("quote_not_in_chunk", f"quote absent from {chunk_id[:8]}")
    if not has_substance(quote):
        # A section title quoted on its own proves the section exists and
        # nothing else. The operator needs the sentence that states the rule.
        return None, GateFailure("quote_without_substance", quote[:60])
    locator = dict(hit.locator or {})
    if not any(locator.get(key) for key in ("page", "section", "table")):
        return None, GateFailure("locator_missing", chunk_id[:8])
    return _accepted_citation(hit, chunk_id, quote, assembled, locator), None


def _quote_is_assembled(quote: str, hit: Hit) -> bool | None:
    """False when the quote is a contiguous span of the chunk, True when it was
    assembled from the cells of a table in order, None when it is not there."""
    if flatten_for_match(quote) in flatten_for_match(hit.text):
        return False
    if _is_table(hit) and assembled_match(quote, hit.text):
        return True
    return None


def _citation_shape(citation: dict) -> tuple[str, str]:
    quote = citation.get("quote")
    return str(citation.get("chunk_id") or ""), quote.strip() if isinstance(quote, str) else ""


def _accepted_citation(hit: Hit, chunk_id: str, quote: str, assembled: bool, locator: dict) -> dict:
    return {
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
        # The gates below read this copy, so it is the whole span the model
        # quoted, up to the prompt's own limit, with the page layout's runs of
        # spaces collapsed so they do not spend it. Cutting it at 300 dropped the
        # "Prazo: 31/12/2023" that closes an action of the RAP, and a claim
        # about the deadline was refused as a number not in its quote.
        "quote": re.sub(r"\s+", " ", quote).strip()[:MAX_QUOTE_CHARS],
        "assembled": assembled,
        "url": hit.url,
        "sha256": hit.sha256,
        "chunk_id": chunk_id,
        "external_id": hit.external_id,
        "revision": hit.revision,
    }


def _numbers_not_quoted(claim: str, citations: list[dict], restated: str = "") -> list[GateFailure]:
    """Token comparison, not substring: a claim saying 26 must not be accepted
    because the quote happens to contain 260.

    A number the question already carries is not an invention. The record being
    explained is itself full of numbers — "LT 500 kV Açu III / Jaguaruana II –
    C1(V7)", "SGI N° 46.066-26" — and a claim that names the line it is about is
    repeating the record, not asserting a measurement. Requiring the document to
    contain them refused every claim about a line whose voltage the operating
    instruction writes in a heading. What the gate exists for is unchanged: a
    number that appears in neither the record nor the quoted text is refused.
    """
    quoted = {_number_key(number) for citation in citations for number in numbers_in(citation["quote"])}
    # The item a citation points at ("6.2.1") is printed with it, so naming it
    # in the claim invents nothing.
    quoted |= {
        _number_key(number)
        for citation in citations
        for number in numbers_in((citation.get("locator") or {}).get("section") or "")
    }
    quoted |= {_number_key(number) for number in numbers_in(restated)}
    return [
        GateFailure("number_not_in_quote", number)
        for number in numbers_in(claim)
        if _number_key(number) not in quoted
    ]


def _support_and_confidence(item: dict) -> tuple[str, str]:
    supports = (item.get("supports") or "NONE").upper()
    if supports not in EVIDENCE_WEIGHT:
        supports = "NONE"
    confidence = (item.get("confidence") or "low").lower()
    if confidence not in CONFIDENCES:
        confidence = "low"
    # REL without a published intervention schedule can never be high: the
    # document that would settle it is not public.
    if supports == "REL" and confidence == "high":
        confidence = "medium"
    return supports, confidence


def _item_shape(item: Any) -> tuple[str, list, GateFailure | None]:
    """The claim text and the citation list, or why the item has neither."""
    if not isinstance(item, dict):
        return "", [], GateFailure("schema_invalid", f"item is {type(item).__name__}")
    claim = (item.get("claim") or "").strip() if isinstance(item.get("claim"), str) else ""
    if len(claim) < 10:
        return "", [], GateFailure("schema_invalid", "claim too short")
    citations = item.get("citations")
    if not isinstance(citations, list):
        return "", [], GateFailure("schema_invalid", "citations is not a list")
    return claim, citations, None


def check_claim(
    item: Any, by_chunk: dict[str, Hit], record: Record | None = None
) -> tuple[dict | None, list[GateFailure]]:
    """Run the gates. Returns the accepted claim, or the reasons it failed.

    The model's output is untrusted input: a string where an object was asked
    for is a rejected claim, never an exception.
    """
    record = record or Record()
    claim, citations, shape_failure = _item_shape(item)
    if shape_failure:
        return None, [shape_failure]

    accepted: list[dict] = []
    failures: list[GateFailure] = []
    for citation in citations:
        ok, failure = _check_citation(citation, by_chunk, record)
        if ok:
            accepted.append(ok)
        elif failure:
            failures.append(failure)
    if not accepted:
        return None, failures or [GateFailure("quote_not_in_chunk", "no citation survived")]

    missing = _numbers_not_quoted(claim, accepted, record.question)
    if missing:
        return None, [*failures, *missing]
    causal = causal_hits(claim)
    if causal:
        return None, [*failures, GateFailure("causal_vocabulary", ", ".join(causal))]

    supports, confidence = _support_and_confidence(item)
    claim_document = {
        "claim": claim[:400],
        "supports": supports,
        "confidence": confidence,
        "evidence_weight": EVIDENCE_WEIGHT[supports],
        "period": None,
        "citations": accepted[:MAX_CITATIONS],
    }
    return claim_document, failures


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
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"Question: {record.question}\n\nAvailable passages:\n\n{passages}{complaint}",
            },
        ]
        try:
            result = await gateway.run(
                "generate_strong", tokens=max(1, len(passages) // 4), messages=messages, want_json=True
            )
        except QuotaExhausted as exc:
            document["verdict"] = "insufficient"
            # Running out on the first attempt and running out after the gates
            # refused two drafts are different problems, and only the first is
            # solved by waiting. Saying "no quota" about a run that was actually
            # refused sends the reader to the provider's dashboard instead of to
            # the gate that rejected the claim.
            document["reason"] = (
                "quota_exhausted_before_answer" if attempt == 1 else "quota_exhausted_partial"
            )
            generation["attempts"] = attempt - 1
            generation["gate_failures"] = sorted({failure.code for failure in failures})
            document["trace"]["retry_at"] = exc.retry_at
            return
        generation.update(
            {"provider": result.provider, "model": result.model, "attempts": attempt, "source": "model"}
        )
        accepted, failures = _gate_answer(result.value, by_chunk, attempt, generation, record)
        if accepted:
            break
        complaint = _complaint(guidance, failures)
    generation["gate_failures"] = sorted({failure.code for failure in failures})
    _settle(document, accepted, record.question)


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
    # refuses exactly what was refused here: numbers from the quoted text, plus
    # the ones the record itself already stated.
    document["numbers_whitelist"] = sorted(
        {
            number
            for claim in accepted
            for citation in claim["citations"]
            for number in numbers_in(citation["quote"])
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
