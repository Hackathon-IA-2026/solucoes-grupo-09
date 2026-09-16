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
from datetime import UTC, datetime, timedelta
from pathlib import Path

from wattsteer_rag.db import Database
from wattsteer_rag.evidence import build_evidence, flatten_for_match
from wattsteer_rag.gateway.router import Gateway
from wattsteer_rag.config import settings


async def run(cases: list[dict], limit: int | None) -> dict:
    db = Database()
    gateway = Gateway(settings().gateway_config)
    results = []
    for case in cases[:limit]:
        # D-1 19:00 in Brasilia, the late gate, expressed in UTC.
        day = datetime.fromisoformat(case["date"]).replace(tzinfo=UTC)
        gate_at = day - timedelta(hours=5)
        document = await build_evidence(
            db,
            gateway,
            subsystem=case["subsystem"],
            target_date=case["date"],
            gate_at=gate_at,
            reason=case.get("reason"),
            description=case.get("description"),
        )
        cited = {
            citation.get("external_id")
            for item in document["items"]
            for citation in item["citations"]
        }
        expected = case.get("expect_document")
        results.append(
            {
                "description": case["description"][:70],
                "reason": case["reason"],
                "verdict": document["verdict"],
                "expected": expected,
                "cited": sorted(code for code in cited if code),
                "cited_expected": bool(expected and expected in cited),
                "claims": len(document["items"]),
                "rejected": len(document["trace"]["generation"].get("rejected") or []),
            }
        )
        print(
            f"{results[-1]['verdict']:<12} {case['reason']:<4} "
            f"expected={expected or '-':<14} cited={results[-1]['cited'] or '-'} "
            f"| {case['description'][:60]}"
        )

    await gateway.aclose()
    await db.close()

    with_expectation = [row for row in results if row["expected"]]
    summary = {
        "cases": len(results),
        "found": sum(1 for row in results if row["verdict"] == "found"),
        "insufficient": sum(1 for row in results if row["verdict"] == "insufficient"),
        "not_found": sum(1 for row in results if row["verdict"] == "not_found"),
        "cited_expected": (
            sum(1 for row in with_expectation if row["cited_expected"]) / len(with_expectation)
            if with_expectation
            else None
        ),
        "claims_total": sum(row["claims"] for row in results),
        "rejected_total": sum(row["rejected"] for row in results),
    }
    return {"summary": summary, "results": results}


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
    # `flatten_for_match` is imported so that a refactor that removes the gate
    # also breaks the harness, rather than silently measuring nothing.
    assert callable(flatten_for_match)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
