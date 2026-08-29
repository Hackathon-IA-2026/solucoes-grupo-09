# 11 — The most-viewed screen survives a modelling outage

**What to build:** the day-ahead forecast for one subsystem, served from
Postgres, versioned, shaped by the gateway — and the provisional proxy route it
replaces, deleted.

Query parameters: subsystem (required, one of the four), target date (optional,
defaulting to tomorrow in Brasília), gate profile (optional, defaulting to the
late gate). **There is no technology parameter** — the forecast grain is the
subsystem and the split is a scalar.

**Why the existing route goes.** The proxy module stays and keeps its failure
mapping; the *route* it carries is a stopgap in four specific ways: it is
unversioned, against a modelling service whose own path is versioned; it returns
the upstream body verbatim on the ground that "the forecast contract belongs to
the service that computes it", which is the right instinct for a proxy and the
wrong one for a **record** — the gateway must add the origin kind, the as-of pin,
the risk class from the artifact's bins and the licence attribution; it cannot
honour the origin-kind filter, because a verbatim proxy has no row to filter; and
it makes the most-viewed screen depend on the modelling service.

**Five decisions inside the response shape:**

1. The day band and the peak-power band are **read from the persisted day-grain
   row, never computed from the hours** — they are path-ensemble quantiles.
2. The expectation appears at both grains and is **never inside the band**.
3. The split is two scalars at both grains, with no split band.
4. **The origin kind is on every origin, and this endpoint filters to `served`
   unconditionally, in the query, not in a branch.**
5. The age in hours is derived and returned, because "is this stale" is a
   question every screen asks and none should answer by differencing against a
   clock the server has and the client may not.

**The four "no forecast" states are four different sentences** and collapsing
them into a spinner is the failure this ticket exists to prevent:

- **Not yet published** — the gate has not passed. **This is not an error state
  on screen.** The Overview shows *today's* forecast, clearly dated, beside one
  line naming the next publication instant, which comes from the meta endpoint so
  the sentence is data. A countdown is optional; an error is wrong.
- **No promoted artifact** — a 503 carrying which of the three artifact states
  holds. The Overview renders its **observed** panels, which need no model at
  all; the forecast panels are *absent*, not skeletons and not zeroed bands.
  Explain and Mitigate are disabled with the same sentence. The Time Machine
  still works, because it reads pinned rows and never the serving artifact —
  a real and slightly surprising product property that is worth putting on screen.
- **Published but stale** — a **200**. The response carries its age and its gate
  profile; the screen renders the numbers and names the origin, which it is
  obliged to do anyway. Past a configurable age the origin line takes a warning
  tone. Nothing is hidden and nothing is refused.
- **The gateway or the database is down** — a 503 with `Retry-After`, the only
  one that gets a generic message.

**The standing rule across all four: never an invented number, and never a zero
standing in for an absence.** An absent forecast renders as an absence, a null
avoidability renders as a dash with its "undefined, not zero" explanation, and an
empty hours array is never drawn as a flat line at zero.

**This ticket adds user-facing copy** for the four states, in both locales,
Portuguese first, through the dictionaries and under the hardcoded-string guard.

**Blocked by:** 04, 10. The proxy route is deleted only once the persisted rows
exist — until then it stays and is documented as provisional (ticket 01 keeps its
mapping honest in the meantime).

**Status:** ready-for-agent

- [ ] The route resolves entirely from Postgres, returning a 200 against a fixture database with the modelling service's URL unset
- [ ] The proxy's forecast route is deleted; the module and its failure mapping survive
- [ ] A backfilled-holdout row is never returned under any query, including one naming its publication instant exactly
- [ ] The day figures are read from the day-grain row and a grep-level test forbids reducing an hourly band into a day figure
- [ ] The four absence states produce four distinct outcomes, two of which are 200s, and neither 200 zero-fills a field
- [ ] The next-publication sentence is built from meta data, not a hardcoded time
- [ ] All four states' copy exists in both locales and passes the hardcoded-string guard
- [ ] With no promoted artifact, the Overview still renders its observed panels and the Time Machine still returns a complete replay
