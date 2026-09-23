"""Measure the service against the records it will be asked about.

Three numbers, and only the third is a quality claim:

  cited_expected  the answer cites the document the record named
  no_invention    no claim was accepted whose quote is not in the corpus (by
                  construction, so a drop here means a gate regressed)
  refusal_rate    how often the honest answer was "insufficient"

A high refusal rate with a small corpus is correct behaviour, not failure.

A case with a `question` is a free question instead of a record, from
`eval/questions.jsonl`: each one carries the document and page that answer it
and the numbers the published text states, checked by hand against the official
file. It scores as correct, refused or wrong, and wrong is the number to drive
to zero:

    python eval/run_eval.py --goldset eval/questions.jsonl --ids B,O
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path

from wattsteer_rag.db import Database
from wattsteer_rag.evidence import build_evidence
from wattsteer_rag.gate import _number_key
from wattsteer_rag.gateway.router import Gateway
from wattsteer_rag.runtime import open_runtime


async def run(cases: list[dict], limit: int | None, patience: float) -> dict:
    async with open_runtime() as rt:
        results = []
        for case in cases[:limit]:
            row = await _evaluate_patiently(rt.db, rt.gateway, case, patience)
            results.append(row)
            print(_line(row, case), flush=True)
    return {"summary": _summary(results), "results": results}


async def _evaluate_patiently(db: Database, gateway: Gateway, case: dict, patience: float) -> dict:
    """A free tier that says "not this minute" is not a result.

    One evidence request is around 24,000 tokens of passages and the ceiling is
    60,000 a minute, so a run of fourteen records asks for roughly six minutes of
    quota in a few seconds. Recording those as refusals measures the plan, not
    the service: the gateway already says when it can answer, so the harness
    waits for that instant and asks again.

    Only a case that got no answer at all is retried. A case whose drafts were
    refused by the gates and then ran out of quota on the last attempt has been
    measured already, and asking again spends the quota of a case that has not.
    """
    deadline = time.monotonic() + patience
    while (row := await _evaluate(db, gateway, case))["verdict_reason"] == "quota_exhausted_before_answer":
        retry_at = row.get("retry_at")
        wait = min(max(30.0, (retry_at - time.time()) if retry_at else 30.0), patience)
        if time.monotonic() + wait > deadline:
            break
        print(f"  waiting {wait:.0f}s for quota", flush=True)
        await asyncio.sleep(wait)
    return row


async def _evaluate(db: Database, gateway: Gateway, case: dict) -> dict:
    if case.get("question"):
        return await _evaluate_question(db, gateway, case)
    # D-1 19:00 in Brasilia, the late gate, expressed in UTC.
    day = datetime.fromisoformat(case["date"]).replace(tzinfo=UTC)
    document = await build_evidence(
        db,
        gateway,
        subsystem=case["subsystem"],
        target_date=case["date"],
        gate_at=day - timedelta(hours=5),
        reason=case.get("reason"),
        description=case.get("description"),
    )
    cited = {citation.get("external_id") for item in document["items"] for citation in item["citations"]}
    expected = case.get("expect_document")
    generation = document["trace"]["generation"]
    return {
        "description": case["description"][:70],
        "reason": case["reason"],
        "verdict": document["verdict"],
        # Without this a run that ran out of quota looks exactly like a run
        # whose claims were refused, and they need different fixes.
        "verdict_reason": document.get("reason"),
        "provider": generation.get("provider"),
        "gate_failures": generation.get("gate_failures") or [],
        "candidates": document["trace"]["retrieval"]["hybrid_candidates"],
        "expected": expected,
        "cited": sorted(code for code in cited if code),
        "cited_expected": bool(expected and expected in cited),
        "claims": len(document["items"]),
        "rejected": len(generation.get("rejected") or []),
        "retry_at": document["trace"].get("retry_at"),
    }


async def _evaluate_question(db: Database, gateway: Gateway, case: dict) -> dict:
    """A question asked after the fact, so every document published by now counts."""
    document = await build_evidence(
        db,
        gateway,
        subsystem=case["subsystem"],
        target_date=case["date"],
        gate_at=datetime.now(UTC),
        question=case["question"],
    )
    generation = document["trace"]["generation"]
    scored = _score(case, document)
    if document["verdict"] != "found" and document.get("reason") in UNAVAILABLE:
        scored["grade"] = "unavailable"
    return {
        "id": case["id"],
        "verdict": document["verdict"],
        "verdict_reason": document.get("reason"),
        **scored,
        "provider": generation.get("provider"),
        "gate_failures": generation.get("gate_failures") or [],
        "claims": len(document["items"]),
        "claim_texts": [item["claim"] for item in document["items"]],
        "rejected": len(generation.get("rejected") or []),
        "retry_at": document["trace"].get("retry_at"),
    }


# No provider could answer: a free tier out for the minute, or a model answering
# 503. Measured on 22/09/2026, six such refusals were each correct twice when
# asked again. They say whether a provider was up, not whether the service
# reads the record right, so they are counted apart from the refusals.
UNAVAILABLE = {"quota_exhausted_before_answer", "quota_exhausted_partial", "claim_reader_unavailable"}


def _score(case: dict, document: dict) -> dict:
    """Right document, and every number the published text states for the
    question, stated by a claim that cites that document."""
    citations = _citations(document)
    expected, wanted, stated = _reading(case, document["items"])
    on_document = [citation for citation in citations if citation.get("external_id") in expected]
    missing = _missing(wanted, stated)
    return {
        "grade": _grade(
            case.get("expect", "answer"), document["verdict"] == "found", bool(on_document) and not missing
        ),
        "expected": ", ".join(sorted(expected)) or None,
        "cited": sorted({citation.get("external_id") or "" for citation in citations} - {""}),
        "cited_expected": bool(on_document),
        "page_expected": any(
            citation["locator"].get("page") == case.get("expect_page") for citation in on_document
        ),
        "numbers_missing": sorted(missing),
    }


def _reading(case: dict, items: list[dict]) -> tuple[set[str], list[str], list[str]]:
    """The primary answer, or another official table that states the same fact
    ("also"), each with its own document and its own printed numbers, and the
    claims that cite that document: a number stated under another citation
    does not count for this one."""
    readings = [(_expected_documents(case), case.get("expect_numbers") or [])]
    readings += [({alt["document"]}, alt["numbers"]) for alt in case.get("also") or []]
    for documents, numbers in readings:
        stated = _claims_citing(items, documents)
        if stated and not _missing(numbers, stated):
            return documents, numbers, stated
    documents, numbers = readings[0]
    return documents, numbers, _claims_citing(items, documents)


def _claims_citing(items: list[dict], documents: set[str]) -> list[str]:
    return [
        item["claim"]
        for item in items
        if any(citation.get("external_id") in documents for citation in item["citations"])
    ]


NUMBER_TOKEN = re.compile(r"\d(?:[\d.,]*\d)?")
MINUS = "-\u2212\u2013"


def _signed(texts) -> set[tuple[str, str]]:
    """(sign, magnitude) of every number. A minus belongs to the number it
    precedes ("- 75", "-75") unless it follows an operand: after ")" or a digit
    it is an operation ("P(L7) – 0,51", the range "1.720–4.260"). A plus is
    kept as such: it answers an unsigned value ("um incremento de + 30 MW"
    answers 30) and never a negative one."""
    return {
        (_sign_before(text, match.start()), _number_key(match.group()))
        for text in texts
        for match in NUMBER_TOKEN.finditer(text)
    }


def _sign_before(text: str, start: int) -> str:
    head = text[:start].rstrip()
    if not head or head[-1] not in MINUS + "+" or (start - len(head) > 1):
        return ""
    operand = head[:-1].rstrip()[-1:]
    if operand and (operand.isdigit() or operand in ")]"):
        return ""
    return "+" if head[-1] == "+" else "-"


def _missing(wanted: list[str], stated: list[str]) -> list[str]:
    """Expected numbers no claim states. An unsigned number in the claim stands
    for its magnitude ("uma redução de 75 MW" answers -75); the opposite sign
    stated outright does not."""
    said = _signed(stated)
    return [
        f"{sign}{key}"
        for sign, key in _signed(wanted)
        if not any(key == other and _agrees(sign, other_sign) for other_sign, other in said)
    ]


def _agrees(wanted: str, stated: str) -> bool:
    return stated in (wanted, "") or (wanted == "" and stated == "+")


def _citations(document: dict) -> list[dict]:
    return [citation for item in document["items"] for citation in item["citations"]]


def _expected_documents(case: dict) -> set[str]:
    expected = case.get("expect_document") or []
    return set(expected if isinstance(expected, list) else [expected])


def _grade(expect: str, answered: bool, right: bool) -> str:
    """Refusing is honest; answering with the wrong document or number is not."""
    if not answered:
        return "refused" if expect == "answer" else "correct"
    if expect == "refuse":
        return "wrong"
    return "correct" if right else "wrong"


def _line(row: dict, case: dict) -> str:
    if "grade" in row:
        page = "page ok" if row["page_expected"] else "page -"
        return (
            f"{row['grade']:<8} {row['id']:<4} {row['verdict']:<12} {page:<7} "
            f"expected={row['expected'] or '-'} cited={row['cited'] or '-'} "
            f"missing={row['numbers_missing'] or '-'} | {case['question'][:60]}"
        )
    return (
        f"{row['verdict']:<12} {case['reason']:<4} {(row['verdict_reason'] or ''):<26} "
        f"expected={row['expected'] or '-':<14} cited={row['cited'] or '-'} | {case['description'][:46]}"
    )


def _summary(results: list[dict]) -> dict:
    with_expectation = [row for row in results if row["expected"]]
    cited = sum(1 for row in with_expectation if row["cited_expected"])
    verdicts = Counter(row["verdict"] for row in results)
    reasons = Counter(row["verdict_reason"] for row in results)
    return {
        "cases": len(results),
        "found": verdicts["found"],
        "insufficient": verdicts["insufficient"],
        "not_found": verdicts["not_found"],
        "cited_expected": cited / len(with_expectation) if with_expectation else None,
        "claims_total": sum(row["claims"] for row in results),
        "rejected_total": sum(row["rejected"] for row in results),
        "quota_exhausted": reasons["quota_exhausted_partial"] + reasons["quota_exhausted_before_answer"],
        "no_coverage": reasons["corpus_no_coverage_for_date"],
        **_question_summary(results),
    }


def _question_summary(results: list[dict]) -> dict:
    rows = [row for row in results if "grade" in row]
    if not rows:
        return {}
    grades = Counter(row["grade"] for row in rows)
    by_family: dict[str, Counter] = {}
    for row in rows:
        by_family.setdefault(row["id"][0], Counter())[row["grade"]] += 1
    measured = len(rows) - grades["unavailable"]
    answered = grades["correct"] + grades["wrong"]
    return {
        "correct": grades["correct"],
        "refused": grades["refused"],
        "wrong": grades["wrong"],
        "unavailable": grades["unavailable"],
        # Two numbers, because they answer two questions. Accuracy: of the cases
        # a provider was up for, how many were right. Precision: of the answers
        # given, how many were right. Availability is the unavailable count.
        "accuracy": round(grades["correct"] / measured, 4) if measured else None,
        "precision": round(grades["correct"] / answered, 4) if answered else None,
        "page_expected": sum(1 for row in rows if row["page_expected"]),
        "by_family": {family: dict(counter) for family, counter in sorted(by_family.items())},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--goldset", default="eval/goldset.jsonl")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--ids", default=None, help="only cases whose id starts with one of these, e.g. B,O")
    parser.add_argument("--out", default="eval/last-run.json")
    parser.add_argument(
        "--patience",
        type=float,
        default=420.0,
        help="seconds a single case may spend waiting for free-tier quota",
    )
    args = parser.parse_args()

    cases = [json.loads(line) for line in Path(args.goldset).read_text().splitlines() if line.strip()]
    if args.ids:
        cases = [case for case in cases if case.get("id", "").startswith(tuple(args.ids.split(",")))]
    report = asyncio.run(run(cases, args.limit, args.patience))
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print("\n" + json.dumps(report["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
