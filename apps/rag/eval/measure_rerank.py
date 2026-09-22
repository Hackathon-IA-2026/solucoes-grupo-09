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

**Unresolved, and left here rather than smoothed over.** Run directly against
one question, `_answered(base)` for A09 is `True` and `_answered(ranked)` is
`False` — the reranker *demotes* the answering passage out of the top 8, which
is a `LOST` this summary should name. Run through `main()`, the same question
records `rrf: False`, so the loss is invisible: it looks like retrieval never
found it. The pool, both arm counts and the vector head are identical in both
paths, and retrieval is stable across trials. Until that is explained, treat
`rrf_hits` as unverified — and note that the decision this file exists to
support was taken on a number produced the same way.

It does need **embedding** quota, and that is the trap this file fell into.
`retrieve.py` answers from text search alone when the query embedding is
refused — correct for the product, silent by design — so a run that exhausts
the free tier part-way keeps scoring, and the later rows are a different
retrieval under the same name. Each row now records how many hits each arm
contributed, and the summary is computed over the two-armed rows only.
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
            # Which arms actually ran. `retrieve.py` swallows a `QuotaExhausted`
            # on the query embedding and answers from text search alone — right
            # for the product, and silent, which is wrong for a measurement:
            # every such row scores a *different retrieval* under the same name.
            vector_arm = sum(1 for hit in pool if hit.vector_rank is not None)
            text_arm = sum(1 for hit in pool if hit.text_rank is not None)
            # The vector arm's own head, recorded so two runs can be compared
            # chunk by chunk. A count of 40 says the arm *ran*; it does not say
            # it returned the same 40, and the two are not the same claim —
            # A09 scores rank 1 standalone and a miss inside a 67-question run,
            # with both arms reporting 40 in each. Something moves the query
            # embedding late in a run and nothing here could see it.
            vector_head = [
                hit.external_id
                for hit in sorted(
                    (h for h in pool if h.vector_rank is not None),
                    key=lambda h: h.vector_rank or 0,
                )[:5]
            ]
            row = {
                "id": case["id"],
                "rrf": _answered(base, case),
                "reranked": _answered(ranked, case),
                "pool": len(pool),
                "vector_arm": vector_arm,
                "text_arm": text_arm,
                "hybrid": vector_arm > 0 and text_arm > 0,
                "vector_head": vector_head,
            }
            rows.append(row)
            moved = {(False, True): "RESCUED", (True, False): "LOST"}.get((row["rrf"], row["reranked"]), "")
            print(
                f"{row['id']:<5} rrf={'hit ' if row['rrf'] else 'miss'} "
                f"rerank={'hit ' if row['reranked'] else 'miss'} "
                f"vec={vector_arm:<3} txt={text_arm:<3}"
                f"{'' if row['hybrid'] else '  ONE-ARMED'} {moved}",
                flush=True,
            )

    # Scored over the hybrid rows only. A one-armed row is not a worse
    # retrieval, it is a *different* one, and averaging the two produced the
    # headline this file carried for a day: "52 -> 59, 7 rescued" over a set in
    # which 37 of 67 rows had lost the vector arm to the free tier. Re-measured
    # with both arms, the reranker rescued none of them. Which of those two
    # numbers is the reranker's is not a question an average can answer, so the
    # partial rows are counted and named rather than folded in.
    scored = [r for r in rows if r["hybrid"]]
    one_armed = [r["id"] for r in rows if not r["hybrid"]]
    summary = {
        "model": args.model,
        "top_hits": top,
        "cases": len(rows),
        "scored": len(scored),
        "one_armed": one_armed,
        "rrf_hits": sum(r["rrf"] for r in scored),
        "reranked_hits": sum(r["reranked"] for r in scored),
        "rescued": [r["id"] for r in scored if not r["rrf"] and r["reranked"]],
        "lost": [r["id"] for r in scored if r["rrf"] and not r["reranked"]],
        "missed_by_both": [r["id"] for r in scored if not r["rrf"] and not r["reranked"]],
    }
    Path(args.out).write_text(json.dumps({"summary": summary, "rows": rows}, indent=2))
    print("\n" + json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
