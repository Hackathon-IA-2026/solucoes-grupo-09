"""Build the evaluation set from real curtailment records.

The questions are not invented: every one of them is a record the ONS published,
with the reason it declared and the control it named. That is what the service
will be asked in production, so it is what it should be measured on.

Two sources, same output. The default is the ONS open data, which publishes the
constrained-off record as one CSV per month since October 2021 and does not
depend on our own API being up:

    python eval/build_goldset.py 2026_08 --out eval/goldset.jsonl

A month is 47 MB and around 230,000 rows, and the cases are the distinct
(reason, description) pairs in it, ordered by the energy behind each. Ordering
matters: August 2026 has 61 distinct descriptions, and the first few account for
most of the curtailed energy, so a short run measures what is actually asked.

    python eval/build_goldset.py --from-api 2026-09-14 2026-08-20

is the older path, which reads the product API day by day.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

API = "https://api.wattsteer.com/v1/curtailment/reasons"
SUBSYSTEMS = ("NE", "S", "SE", "N")
CODE = re.compile(r"\b(?:IO|IT)-[A-Z0-9.]{2,}")

# The constrained-off record, as the ONS publishes it. Wind first: it is where
# almost all of the curtailed energy is.
OPEN_DATA = {
    "eolica": (
        "https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_eolica_tm/"
        "RESTRICAO_COFF_EOLICA_{month}.csv"
    ),
    "solar": (
        "https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_fotovoltaica_tm/"
        "RESTRICAO_COFF_FOTOVOLTAICA_{month}.csv"
    ),
}


def _case(
    *, subsystem: str, day: str, reason: str, origin: str | None, description: str, entity: str | None
) -> dict:
    # What a correct answer must cite. A record naming an operating
    # instruction has an exact expected document; the others only require
    # that nothing is invented.
    match = CODE.search(description)
    return {
        "subsystem": subsystem,
        "date": day,
        "reason": reason,
        "origin": origin,
        "description": description,
        "expect_document": match.group(0) if match else None,
        "entity": entity,
    }


# The ONS open data ----------------------------------------------------


def read_month(source: str, month: str) -> io.TextIOWrapper:
    url = OPEN_DATA[source].format(month=month)
    request = urllib.request.Request(url, headers={"user-agent": "WattSteer-RAG-eval/0.1"})
    response = urllib.request.urlopen(request, timeout=300)
    # 47 MB a month, read as it arrives rather than held twice in memory.
    return io.TextIOWrapper(response, encoding="utf-8-sig", newline="")


def collect_open_data(months: list[str], sources: list[str]) -> tuple[dict, Counter]:
    seen: dict[tuple[str, str], dict] = {}
    energy: Counter[str] = Counter()
    for month in months:
        for source in sources:
            try:
                stream = read_month(source, month)
            except Exception as exc:  # noqa: BLE001 - a month that is not published yet is not fatal
                print(f"{source} {month}: {type(exc).__name__}", file=sys.stderr)
                continue
            rows = 0
            with stream:
                for row in csv.DictReader(stream, delimiter=";"):
                    description = (row.get("dsc_restricao") or "").strip()
                    reason = (row.get("cod_razaorestricao") or "").strip()
                    if not description or not reason:
                        continue
                    rows += 1
                    energy[description] += _float(row.get("val_geracaonaorealizadaapurada"))
                    seen.setdefault(
                        (reason, description),
                        _case(
                            subsystem=(row.get("id_subsistema") or "").strip(),
                            day=(row.get("din_instante") or "")[:10],
                            reason=reason,
                            origin=(row.get("cod_origemrestricao") or "").strip() or None,
                            description=description,
                            entity=(row.get("nom_usina") or "").strip() or None,
                        ),
                    )
            print(f"{source} {month}: {rows} rows with a reason", file=sys.stderr)
    return seen, energy


def _float(value: str | None) -> float:
    try:
        return float((value or "0").replace(",", "."))
    except ValueError:
        return 0.0


# The product API ------------------------------------------------------


def fetch(subsystem: str, day: str) -> list[dict]:
    request = urllib.request.Request(
        f"{API}?subsystem={subsystem}&date={day}",
        headers={"accept": "application/json", "user-agent": "WattSteer-RAG-eval/0.1"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode()).get("rows", [])


def collect_api(days: list[str]) -> tuple[dict, Counter]:
    seen: dict[tuple[str, str], dict] = {}
    energy: Counter[str] = Counter()
    for day in days:
        for subsystem in SUBSYSTEMS:
            try:
                rows = fetch(subsystem, day)
            except Exception as exc:  # noqa: BLE001 - a missing day is not fatal
                print(f"{subsystem} {day}: {type(exc).__name__}", file=sys.stderr)
                continue
            for row in rows:
                description = (row.get("description") or "").strip()
                if not description:
                    continue
                energy[description] += row.get("constrained_off_mwh") or 0
                seen.setdefault(
                    (row["reason"], description),
                    _case(
                        subsystem=subsystem,
                        day=day,
                        reason=row["reason"],
                        origin=row.get("origin"),
                        description=description,
                        entity=row.get("entity_label"),
                    ),
                )
    return seen, energy


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("months", nargs="*", help="months of ONS open data, as YYYY_MM")
    parser.add_argument("--source", nargs="+", default=["eolica"], choices=sorted(OPEN_DATA))
    parser.add_argument("--from-api", nargs="+", metavar="DAY", help="read the product API instead")
    parser.add_argument("--limit", type=int, default=None, help="keep only the N cases with the most energy")
    parser.add_argument("--out", default="eval/goldset.jsonl")
    args = parser.parse_args()

    if args.from_api:
        seen, energy = collect_api(args.from_api)
    elif args.months:
        seen, energy = collect_open_data(args.months, args.source)
    else:
        parser.error("give at least one month (YYYY_MM) or use --from-api")

    cases = sorted(seen.values(), key=lambda case: -energy[case["description"]])
    if args.limit:
        cases = cases[: args.limit]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as handle:
        for case in cases:
            handle.write(json.dumps(case, ensure_ascii=False) + "\n")
    with_document = sum(1 for case in cases if case["expect_document"])
    print(f"{len(cases)} distinct records -> {out} ({with_document} name a document)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
