"""Does reranking put the answering passage in front of the drafter?

`docs/rag/decisions.md` asks for a reranker to be measured against the RRF
order before it is turned on. This is that measurement, and it deliberately
scores **retrieval**, not answers: it asks, for every goldset question that
names the numbers its document states, whether a passage containing one of them
is among the `top_hits` the drafter actually receives.

Two reasons to score it this way rather than by running the whole pipeline:

- It needs no generation quota, so the comparison is repeatable and the two
  arms are scored on identical inputs. An end-to-end A/B would also move with
  the drafter's sampling, and a reranker would be credited or blamed for it.
- It is the property reranking can affect. A passage the drafter never sees is
  the failure this exists for; what the drafter then does with it belongs to
  `gate.py` and `verify.py`, which are measured by `run_eval.py`.

    uv run python eval/measure_rerank.py --model cross-encoder/mmarco-mMiniLMv2-L12-H384-v1
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from wattsteer_rag.config import settings
from wattsteer_rag.rerank import rerank
from wattsteer_rag.retrieve import search
from wattsteer_rag.runtime import open_runtime


def _wanted(case: dict) -> list[str]:
    """The numbers the published text states for this question, as written."""
    return [str(n) for n in (case.get("expect_numbers") or [])]


def _answered(hits: list, case: dict) -> bool:
    """Is a passage that states one of the expected numbers in front of the drafter?

    The document is checked too: the same digits in another report are not the
    answer, which is the distinction `_relevance_failure` exists for.
    """
    documents = {case.get("expect_document")} | {a["document"] for a in case.get("also") or []}
    return any(
        hit.external_id in documents and any(number in hit.text for number in _wanted(case)) for hit in hits
    )


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--goldset", default="eval/questions.jsonl")
    parser.add_argument("--model", default="cross-encoder/mmarco-mMiniLMv2-L12-H384-v1")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--out", default="eval/rerank-measurement.json")
    args = parser.parse_args()

    cases = [json.loads(line) for line in Path(args.goldset).read_text().splitlines() if line.strip()]
    cases = [case for case in cases if case.get("question") and _wanted(case)][: args.limit]
    top = settings().top_hits

    rows = []
    async with open_runtime() as rt:
        for case in cases:
            # One retrieval per question, deep enough to rerank, and both arms
            # are scored on **the same** candidates: anything else would compare
            # two retrievals rather than two orderings.
            pool = await search(rt.db, rt.gateway, case["question"], target_date=case.get("date"), limit=200)
            base = pool[:top]
            ranked = rerank(case["question"], pool, top, model=args.model).hits
            row = {
                "id": case["id"],
                "rrf": _answered(base, case),
                "reranked": _answered(ranked, case),
                "pool": len(pool),
            }
            rows.append(row)
            moved = {(False, True): "RESCUED", (True, False): "LOST"}.get((row["rrf"], row["reranked"]), "")
            print(
                f"{row['id']:<5} rrf={'hit ' if row['rrf'] else 'miss'} "
                f"rerank={'hit ' if row['reranked'] else 'miss'} {moved}",
                flush=True,
            )

    summary = {
        "model": args.model,
        "top_hits": top,
        "cases": len(rows),
        "rrf_hits": sum(r["rrf"] for r in rows),
        "reranked_hits": sum(r["reranked"] for r in rows),
        "rescued": [r["id"] for r in rows if not r["rrf"] and r["reranked"]],
        "lost": [r["id"] for r in rows if r["rrf"] and not r["reranked"]],
    }
    Path(args.out).write_text(json.dumps({"summary": summary, "rows": rows}, indent=2))
    print("\n" + json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
