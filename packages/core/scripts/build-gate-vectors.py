"""Build `fixtures/gate-instant/` — the shared golden vectors for `gate_at`.

**This script is not any of the shipped implementations, and that is the
point.** The gate instant is written three times:

- `apps/api/drizzle/0016_the_feature_gate.sql` — `gate_at(target_date,
  gate_profile)`, resolved by Postgres with `AT TIME ZONE`. It is the authority
  for every feature row's `gate_at` and therefore for every `published_at`.
- `packages/core/src/schedule.ts` — `GATES` plus `localWallClock`, which
  resolves the zone through `Intl.DateTimeFormat` and a second pass, and which
  `apps/api/src/forecast/gate.ts` composes into `gateAt`.
- `apps/ml/tests/feature_row_fixtures.py` — the Python spelling, which mints the
  `gate_at` column on every fabricated feature row.

This script reaches the same answers a fourth way: `datetime.combine` and
`zoneinfo` from the standard library. Each side is asserted against the files
written here and never against another side, so a shared misunderstanding
between two of them has nothing to cancel out against — the third property in
`../fixtures/canonical-contract/README.md`.

The offsets are not written by hand. They come from the IANA time-zone database,
which is the authority all three implementations defer to: ICU on the
TypeScript side, `pg_timezone_names` on the SQL side, `zoneinfo` here. What the
vectors pin on top of that is the *table* — which hour belongs to which profile,
and that the gate is D-1 rather than D — which is the part each implementation
transcribes and can therefore get wrong alone.

Run: `python3 packages/core/scripts/build-gate-vectors.py`, then
`bunx biome check --write packages/core/fixtures/gate-instant` — Biome formats
JSON as well as TypeScript, and `bun run lint` covers the fixtures.
"""

from __future__ import annotations

import json
import pathlib
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

FIXTURES = pathlib.Path(__file__).resolve().parent.parent / "fixtures" / "gate-instant"

#: `GRID_TIME_ZONE`, and the only zone any of the three implementations name.
ZONE = ZoneInfo("America/Sao_Paulo")

#: The gate table, transcribed here so the vectors can pin it. `gate_early` is
#: D-1 09:00 on the 00Z run; `gate_late` is D-1 19:00 on the 12Z run.
HOURS = {"gate_early": 9, "gate_late": 19}


def vector(name: str, why: str, target_date: str, profile: str) -> dict[str, object]:
    target = date.fromisoformat(target_date)
    wall = datetime.combine(
        target - timedelta(days=1), time(hour=HOURS[profile]), tzinfo=ZONE
    )
    # The round trip the SQL performs before it returns: a wall-clock time a
    # spring-forward swallowed has no instant, and a vector pinning one would be
    # pinning whichever way an implementation happened to resolve it.
    assert wall.astimezone(UTC).astimezone(ZONE).replace(tzinfo=ZONE) == wall, name
    offset = wall.utcoffset()
    assert offset is not None
    instant = wall.astimezone(UTC)
    return {
        "name": name,
        "why": why,
        "target_date": target_date,
        "gate_profile": profile,
        "expected_local_date": (target - timedelta(days=1)).isoformat(),
        "expected_local_time": f"{HOURS[profile]:02d}:00",
        "expected_utc_offset_minutes": int(offset.total_seconds() // 60),
        # Millisecond precision and a `Z`, which is what `Date#toISOString`
        # writes: the vector is a string every side can compare without first
        # agreeing on a formatter.
        "expected_gate_at": instant.strftime("%Y-%m-%dT%H:%M:%S.") + f"{instant.microsecond // 1000:03d}Z",
    }


CASES: list[tuple[str, dict[str, object]]] = [
    (
        "01-the-late-gate-for-tomorrow.json",
        vector(
            "the late gate for tomorrow",
            "The primary gate and the ordinary case: D-1 19:00 BRT is 22:00Z, "
            "and it is the instant `/v1/meta` turns into "
            '"tomorrow\'s view publishes at 19:00 BRT".',
            "2026-08-29",
            "gate_late",
        ),
    ),
    (
        "02-the-early-gate-for-the-same-day.json",
        vector(
            "the early gate for the same day",
            "Two gates per target date, ten hours apart. A profile read as a "
            "label rather than an hour would return the same instant twice, "
            "and the 00Z lane would silently claim the 12Z run's inputs.",
            "2026-08-29",
            "gate_early",
        ),
    ),
    (
        "03-the-first-date-the-window-covers.json",
        vector(
            "the first date the window covers",
            "`DATA_WINDOW_OPENS_ON`. Its gate falls in the *previous month*, "
            "which is where an implementation that clamped the gate into the "
            "target date's own month would first be visible.",
            "2024-04-01",
            "gate_late",
        ),
    ),
    (
        "04-a-gate-in-the-previous-year.json",
        vector(
            "a gate in the previous year",
            "New Year's Day is decided on New Year's Eve. D-1 arithmetic done "
            "on the day number alone crosses neither the month nor the year.",
            "2026-01-01",
            "gate_late",
        ),
    ),
    (
        "05-a-gate-on-a-leap-day.json",
        vector(
            "a gate on a leap day",
            "1 March 2024 is decided on 29 February. The only calendar case "
            "where subtracting a day is not subtracting 86 400 000 from a "
            "hand-built date.",
            "2024-03-01",
            "gate_early",
        ),
    ),
    (
        "06-inside-brazils-last-summer-time.json",
        vector(
            "inside Brazil's last summer time",
            "Brazil observed summer time until February 2019, so BRT was "
            "UTC-02:00 here and the gate is 21:00Z rather than 22:00Z. The "
            "data window contains no transition; an implementation that "
            "subtracts a fixed three hours is nevertheless wrong, and this is "
            "the vector that says so.",
            "2019-01-15",
            "gate_late",
        ),
    ),
    (
        "07-the-evening-before-the-clocks-went-forward.json",
        vector(
            "the evening before the clocks went forward",
            "The last gate at UTC-03:00 before the 2018 transition. Paired "
            "with the next vector: two consecutive target dates whose gates "
            "are thirteen hours apart, not fourteen.",
            "2018-11-04",
            "gate_late",
        ),
    ),
    (
        "08-the-morning-the-clocks-went-forward.json",
        vector(
            "the morning the clocks went forward",
            "Brazil sprang forward at midnight on 4 November 2018, so this "
            "gate — 09:00 that same morning — is already UTC-02:00. The "
            "transition is between the two gates of one target date's "
            "neighbourhood, which is the case a per-day offset lookup gets "
            "wrong.",
            "2018-11-05",
            "gate_early",
        ),
    ),
    (
        "09-the-last-gate-under-summer-time.json",
        vector(
            "the last gate under summer time",
            "16 February 2019 at 19:00 is still UTC-02:00; the clocks went "
            "back at midnight on the 17th.",
            "2019-02-17",
            "gate_late",
        ),
    ),
    (
        "10-the-first-gate-after-summer-time-ended.json",
        vector(
            "the first gate after summer time ended",
            "17 February 2019 at 19:00 is UTC-03:00 — one calendar day after "
            "the vector above and one hour further from UTC. Brazil has not "
            "observed summer time since, and this pair is what keeps the code "
            "from assuming it never will again.",
            "2019-02-18",
            "gate_late",
        ),
    ),
]


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, body in CASES:
        (FIXTURES / name).write_text(
            json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"wrote {name}")


if __name__ == "__main__":
    main()
