"""Measure the service against the records it will be asked about.

Three numbers, and only the third is a quality claim:

  cited_expected  the answer cites the document the record named
  no_invention    no claim was accepted whose quote is not in the corpus (by
                  construction, so a drop here means a gate regressed)
  refusal_rate    how often the honest answer was "insufficient"

A high refusal rate with a small corpus is correct behaviour, not failure.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path

from wattsteer_rag.db import Database
from wattsteer_rag.evidence import build_evidence
from wattsteer_rag.gateway.router import Gateway
from wattsteer_rag.runtime import open_runtime


async def run(cases: list[dict], limit: int | None) -> dict:
    async with open_runtime() as rt:
        results = []
        for case in cases[:limit]:
            row = await _evaluate(rt.db, rt.gateway, case)
            results.append(row)
            print(_line(row, case))
    return {"summary": _summary(results), "results": results}


async def _evaluate(db: Database, gateway: Gateway, case: dict) -> dict:
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
    }


def _line(row: dict, case: dict) -> str:
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
        "quota_exhausted": reasons["quota_exhausted_partial"],
        "no_coverage": reasons["corpus_no_coverage_for_date"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--goldset", default="eval/goldset.jsonl")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--out", default="eval/last-run.json")
    args = parser.parse_args()

    cases = [json.loads(line) for line in Path(args.goldset).read_text().splitlines() if line.strip()]
    report = asyncio.run(run(cases, args.limit))
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print("\n" + json.dumps(report["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
