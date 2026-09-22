"""Whether a claim is allowed to exist.

The model writes claims; this module decides which of them survive. Three of the
gates are mechanical and one is not:

1. Every quote must appear in the chunk it cites, character for character once
   whitespace is normalised. A quote that cannot be found is an invention.
2. Every number in a claim must appear in one of that claim's quotes. This is
   the same rule the narration already enforces on the forecast card.
3. No causal vocabulary. The record says what was scheduled or what was
   registered. It never says what caused what: that reading belongs to the rule
   and to SHAP, not to a retrieved paragraph.

The fourth gate — a second, smaller model reading whether the quotes state the
claim about the thing asked — is `verify.py`, and it is applied by the drafting
loop in `evidence.py`, because it costs a request and the mechanical gates do
not. Everything here is a pure function of the claim, its chunks and the record.

## Why this is its own module

`evidence.py` was 869 lines and two things: the gates, and the loop that drafts
against a gateway, retries, reviews and persists. The two halves shared nothing
but a call — {@link check_claim} is `(item, by_chunk, record) -> claim | reasons`
and touches no database, no gateway and no clock — and the cost of their living
together was paid by the reader and by the suite. `test_gates.py`,
`test_context.py` and `test_bulletin.py` are entirely about this half, and they
imported it from a module whose name promised the other one.

The rule for what belongs here: if it needs `await`, it is not a gate.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from typing import Any

from .chunk import TOPIC_SEPARATOR
from .retrieve import Hit, codes_in

MAX_QUOTE_CHARS = 600
SECTION_MAX = 120  # docs/rag/rag-evidence.schema.json, citation.locator.section

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


# A sentence that sends the reader somewhere else for the value.
#
# `tabela abaixo` and `tabela a seguir` were the two the measured run produced;
# the operating instructions also write `quadro`, number their tables, and say
# `seguinte`. Each of those is the same sentence doing the same thing, and a
# rule that only knew two spellings refused the preamble in one instruction and
# accepted it in the next.
#
# Deliberately not a bare `tabela`: the word appears inside rows and titles
# ("Tabela 1 - Usinas"), and the reading below only refuses when **no** part of
# the quote carries a value outside the pointing sentence, so a quote that did
# bring the row through is unaffected either way.
POINTER = re.compile(r"\b(?:tabela|quadro)s?\s+(?:abaixo|a seguir|seguintes?|\d+(?:\.\d+)*)\b", re.IGNORECASE)


def _claim_failures(claim: str, accepted: list[dict], record: Record) -> list[GateFailure]:
    """The checks on the claim as a whole, once its citations are known to exist."""
    if all(_points_to_table(citation["quote"]) for citation in accepted):
        return [
            GateFailure(
                "quote_points_to_table",
                "the quote sends the reader to the table below; quote the table's row that answers too",
            )
        ]
    missing = _numbers_not_quoted(claim, accepted, record.question)
    if missing:
        return missing
    causal = causal_hits(claim)
    if causal:
        return [GateFailure("causal_vocabulary", ", ".join(causal))]
    concluded = conclusion_hits(claim)
    if concluded:
        return [GateFailure("claim_draws_conclusion", ", ".join(concluded))]
    others = agents_not_asked(claim, record.question)
    return [GateFailure("claim_about_another_agent", ", ".join(others))] if others else []


def _points_to_table(quote: str) -> bool:
    """A step's preamble, "remanejar a geração nas usinas definidas na tabela
    abaixo", states what to do and not how much: the amount is in the table. In
    the measured runs, asked how much the plants of one substation must vary,
    three answers quoted only the preamble and gave the step's total. Such a
    quote counts only next to a row of the table it points to: a value in a
    part of the quote other than the pointing sentence and the step number,
    whether the quote kept the table's pipes or not."""
    if not POINTER.search(quote):
        return False
    parts = [part.strip() for part in QUOTE_PARTS.split(quote) if part.strip()]
    return not any(
        re.search(r"\d", part) and not POINTER.search(part) and not STEP_NUMBER.match(part) for part in parts
    )


QUOTE_PARTS = re.compile(r"[|\n]|(?<=\.)\s")
STEP_NUMBER = re.compile(r"^\d+(?:\.\d+)*\.?$")


# The connective that attaches a reading to the figures just quoted. Measured on
# 22/09/2026: "verificado de 25.291 e programado de 24.399, indicando excedente
# de energia" passed every gate and the second reader, three times of three,
# and the balance it quoted has no restriction line. The claim may say what the
# quote says; what the figures would mean is the rule's and the operator's.
# Only right after a figure: of 935 stored claims, the 3 other uses of these
# words described a document ("define o fluxo ..., indicando o sentido
# positivo") or repeated its own words, and none followed a number.
CONCLUSION = re.compile(
    r"\d(?:\s*(?:MWh|MWmed|MW|GWh|GW|Mvar|%))?\s*,?\s+"
    r"((?:indicand|sugerind|implicand|caracterizand|evidenciand|demonstrand)o"
    r"|o que (?:indica|sugere|implica|caracteriza|mostra|evidencia|demonstra|significa))\b",
    re.IGNORECASE,
)


def conclusion_hits(text: str) -> list[str]:
    return [match.group(1) for match in CONCLUSION.finditer(text or "")]


# "O agente LIGHT", "o agente CEMIG D": the name that follows, in capitals.
AGENT = re.compile(r"\bagentes?\s+([A-ZÀ-Ý][\wÀ-ÿ&./-]*(?:\s+[A-ZÀ-Ý][\wÀ-ÿ&./-]*)*)")
ASKS_ABOUT_AGENTS = re.compile(r"\bagentes?\b", re.IGNORECASE)


def agents_not_asked(claim: str, question: str) -> list[str]:
    """The agents a claim is about that the question never named.

    Measured on 22/09/2026: a disturbance report states a restoration time for
    each agent, and asked when the ONS authorised the total restoration the
    answer gave LIGHT's, CEMIG D's or CPFL's, literal and accepted by the second
    reader. A question that speaks of the agents at all may be answered with any
    of them; one that names none of them is not about any one of them.
    """
    if not question or ASKS_ABOUT_AGENTS.search(question) and not AGENT.search(question):
        return []
    asked = _plain(question)
    return [name for name in AGENT.findall(claim) if _plain(name) not in asked]


def causal_hits(text: str) -> list[str]:
    haystack = f" {WORD_BOUNDARY.sub(' ', normalise(text))} "
    return [lemma for lemma in CAUSALITY_BANNED_LEMMAS if f" {lemma} " in haystack]


EVIDENCE_WEIGHT = {"REL": 0.8, "CNF": 0.5, "ENE": 0.3, "NONE": 0.0}
CONFIDENCES = {"high", "medium", "low"}
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


def _off_topic(hit: Hit, record: Record) -> GateFailure | None:
    return (
        _relevance_failure(hit, record)
        or _month_to_date_failure(hit, record)
        or _section_failure(hit, record)
    )


# The IPDO highlights whose content exists nowhere else in the report: the
# restriction's value, period and reasons, and the occurrences. The others
# ("CARGA E PRODUÇÃO ...", "INTERCÂMBIO INTERNACIONAL") restate figures the
# report's tables also hold, so naming them must not refuse the table. Read as a
# prefix, because the 2025 editions split the second one into "OCORRÊNCIAS NA
# REDE DE OPERAÇÃO" and "... DE DISTRIBUIÇÃO".
IPDO_HIGHLIGHTS = ("RESTRIÇÃO DE GERAÇÃO RENOVÁVEL", "OCORRÊNCIAS")
# Only after the word that makes it one: "Rio Grande do Norte" and "Mato Grosso
# do Sul" are places, and an ONS description that names them is not asking for
# a submarket.
ASKED_SUBMARKET = re.compile(r"\b(?:submercado|subsistema)s?\s+(?:d[oa]\s+)?(norte|nordeste|sul|sudeste)\b")


def _section_failure(hit: Hit, record: Record) -> GateFailure | None:
    """The IPDO part the question names, and no other.

    Reported by the domain specialist on 20/09/2026: asked for the main
    occurrence of 14/09, the answer quoted the stored-energy section of the same
    IPDO. Every quote was literal and the document was the right one, so no
    gate refused it. The highlights also repeat the four submarkets under each
    heading, so "Submercado Sul" alone does not say whether it is the Sul's
    production or its restriction. A question that names one of these
    highlights, or one submarket, is answered from that part of the report or
    not at all.
    """
    if hit.source != "IPDO":
        return None
    section = hit.section_path or ""
    topic, _, part = section.rpartition(TOPIC_SEPARATOR)
    asked = [heading for heading in IPDO_HIGHLIGHTS if _names(record.question, heading)]
    if asked and not any((topic or part).startswith(heading) for heading in asked):
        return GateFailure(
            "citation_other_section", f"{hit.external_id} {section!r}, the question asks {asked[0]}"
        )
    named = set(ASKED_SUBMARKET.findall(_plain(record.question)))
    quoted = re.match(r"submercado (\w+)", _plain(part))
    if len(named) == 1 and quoted and quoted.group(1) not in named:
        return GateFailure(
            "citation_other_section", f"{hit.external_id} {section!r}, the question asks {named.pop()}"
        )
    return None


def _plain(text: str) -> str:
    text = "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))
    return re.sub(r"[^\w]+", " ", text.lower()).strip()


def _names(question: str, heading: str) -> bool:
    """Every word of the heading, by its first eight letters: "ocorrência"
    names OCORRÊNCIAS and "ocorreu" does not."""
    words = _plain(question).split()
    stems = [word[:8] for word in _plain(heading).split() if len(word) > 3]
    return all(any(word.startswith(stem) for word in words) for stem in stems)


MONTH_TO_DATE = "Acumulado no Mês"
ASKS_FOR_MONTH = re.compile(r"acumulad|no mês|mensal|até o dia", re.IGNORECASE)


def _month_to_date_failure(hit: Hit, record: Record) -> GateFailure | None:
    """The bulletin's month-to-date balance is not the day's.

    Both pages carry the same rows ("Carga(*) | Sul verificado: ..."), and in
    the sixth measured run three questions about a day were answered from the
    month-to-date page (14.452 for the Sul's load where the day's is 14.611),
    with its title in the chunk and the claim reader told the difference. The
    regional daily table ("Dados Diários Acumulados") is by day and stays.
    """
    if hit.source != "BDO" or MONTH_TO_DATE not in hit.text or ASKS_FOR_MONTH.search(record.question):
        return None
    return GateFailure(
        "citation_month_to_date", f"{hit.external_id} is the month to date, the question asks a day"
    )


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
    off_topic = _off_topic(hit, record)
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
            # The contract bounds a section at 120 characters; some IO titles
            # run to 125 in capitals.
            "section": (locator.get("section") or hit.section_path or "")[:SECTION_MAX] or None,
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

    refused = _claim_failures(claim, accepted, record)
    if refused:
        return None, [*failures, *refused]

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
