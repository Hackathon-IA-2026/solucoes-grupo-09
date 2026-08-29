# The Brazilian holiday calendar, as data

`br_calendar_v1.json` is the materialised Brazilian holiday calendar — every
`(day, uf, name, category)` row the feature layer reads, plus the pinned library
version that produced them and a digest over the rows.

It is **generated, never edited**:

```bash
cd apps/ml && uv run python -m wattsteer_ml.calendar_generator   # rewrite it
cd apps/api && bun run src/scripts/load-calendar.ts             # load it
```

## Why it is a file rather than a library call

`docs/specs/feature-engineering.md` §"The holiday calendar — data, not a library
call". Carnival is a moveable feast. If the feature function called `holidays`
at feature time, an upgrade that moved Carnival by one day would restate three
years of training features the next time anyone rebuilt them — with no
migration, no diff and no failing test — while the deployed model went on
scoring against the geometry of the year it was fitted to.

So regeneration is an explicit act whose diff is reviewed:

- a diff confined to **future** dates extends the horizon;
- a non-empty diff over **past** dates is a **retrain trigger**, and lands as
  `br_calendar_v2` — a new feature-set version. `loadCalendar` refuses to write
  it over `v1`, and says so.

## Who reads it

| party | what it does |
|---|---|
| `apps/ml/.../calendar_generator.py` | produces it from `holidays==0.103` |
| `apps/ml/tests/test_calendar_generator.py` | asserts regeneration reproduces it byte for byte |
| `apps/api/src/features/calendar/calendar.ts` | parses it and checks the digest is the digest of its rows |
| `apps/api/src/features/calendar/calendar-repository.ts` | writes it into `feature_calendar_day`, once |

`uf = 'BR'` is a national holiday; a two-letter code is a holiday that state
observes and the country does not. National days are stored **once**, which is
what keeps `calendar_is_holiday_national` and `calendar_holiday_state_share`
two measurements rather than one counted twice.
