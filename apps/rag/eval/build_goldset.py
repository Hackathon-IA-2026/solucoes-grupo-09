"""Build the evaluation set from real curtailment records.

The questions are not invented: every one of them is a record the ONS published,
with the reason it declared and the control it named. That is what the service
will be asked in production, so it is what it should be measured on.

    python eval/build_goldset.py --days 2026-09-14 2026-08-20 --out eval/goldset.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.request
from collections import Counter
from pathlib import Path

API = "https://api.wattsteer.com/v1/curtailment/reasons"
SUBSYSTEMS = ("NE", "S", "SE", "N")
CODE = re.compile(r"\b(?:IO|IT)-[A-Z0-9.]{2,}")


def fetch(subsystem: str, day: str) -> list[dict]:
    request = urllib.request.Request(
        f"{API}?subsystem={subsystem}&date={day}",
        headers={"accept": "application/json", "user-agent": "WattSteer-RAG-eval/0.1"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode()).get("rows", [])


def _case(row: dict, subsystem: str, day: str, description: str) -> dict:
    # What a correct answer must cite. A record naming an operating
    # instruction has an exact expected document; the others only require
    # that nothing is invented.
    match = CODE.search(description)
    return {
        "subsystem": subsystem,
        "date": day,
        "reason": row["reason"],
        "origin": row.get("origin"),
        "description": description,
        "expect_document": match.group(0) if match else None,
        "entity": row.get("entity_label"),
    }


def collect(days: list[str]) -> tuple[dict[tuple[str, str], dict], Counter[str]]:
    """Distinct (reason, description) records across the days, and the volume behind each."""
    seen: dict[tuple[str, str], dict] = {}
    volume: Counter[str] = Counter()
    for day in days:
        for subsystem in SUBSYSTEMS:
            try:
                rows = fetch(subsystem, day)
            except Exception as exc:  # noqa: BLE001 - a missing day is not fatal
                print(f"{subsystem} {day}: {type(exc).__name__}")
                continue
            for row in rows:
                description = (row.get("description") or "").strip()
                if not description:
                    continue
                volume[description] += row.get("constrained_off_mwh") or 0
                seen.setdefault((row["reason"], description), _case(row, subsystem, day, description))
    return seen, volume


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", nargs="+", required=True)
    parser.add_argument("--out", default="eval/goldset.jsonl")
    args = parser.parse_args()

    seen, volume = collect(args.days)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as handle:
        for case in sorted(seen.values(), key=lambda case: -volume[case["description"]]):
            handle.write(json.dumps(case, ensure_ascii=False) + "\n")
    with_document = sum(1 for case in seen.values() if case["expect_document"])
    print(f"{len(seen)} distinct records -> {out} ({with_document} name a document)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
