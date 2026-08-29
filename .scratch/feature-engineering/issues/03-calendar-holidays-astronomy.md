# 03 — Calendar, holidays and solar astronomy

**What to build:** the feature row carries the deterministic time structure the
Brazilian grid actually runs on — local hour and its cyclical encoding, day of
year, weekday and weekend, the holiday structure including moveable feasts, and
the solar geometry of the target hour.

These are class **`T`**: not forecast, not last-known, simply computable. They
are computed in **Brasília local civil time** from the UTC `valid_time`, because
the diurnal and holiday structure belongs to the grid rather than to UTC.
Everything else in the row stays UTC.

The holiday calendar is **materialised as data, not called at feature time.**
A generator runs once per version and writes `(date, uf, name, category)` rows
plus the pinned generator version; the feature function reads only the table.
This is deliberate: a library upgrade that moves one moveable feast would
otherwise silently restate three years of training features with no migration,
no diff and no test failure. Regeneration is an explicit job whose output diff
is reviewed, and a non-empty diff over past dates is a retrain trigger.
Carnival and Corpus Christi are included — they move the load curve as much as
any statutory holiday.

National and regional are separated. National is a binary; regional enters as
the **share of the subsystem's constituent states** observing a state holiday,
using ONS's electrical state assignment. That share is unweighted by load, and
that is a known crudeness stated rather than smoothed: load is not published per
state, so no honest weight exists inside WattSteer's sources, and inventing one
from population would fabricate a parameter. It ships labelled as a proxy.

`month` and `week_of_year` are **dropped as redundant** with the day-of-year
encoding — a coarser quantisation of the same axis, adding split points without
information.

The canary belongs here because this is where local time enters: the builder
asserts **exactly 24 distinct local hours per target date**. The window contains
no DST transitions and no DST handling is built, but should Brazil reinstate
summer time the assertion fails on the first affected date instead of silently
duplicating or dropping an hour.

Solar astronomy is computed in SQL alongside: cosine of the solar zenith at the
solar-capacity-weighted centroid, and top-of-atmosphere horizontal irradiance.
The second is the denominator the weather block's clearness index needs, which
is why it lands here rather than there.

**Blocked by:** 01 — the gate, end to end.

**Status:** ready-for-agent

- [ ] Local hour, its sin/cos encoding, day-of-year sin/cos, day of week and weekend flag are computed in `America/Sao_Paulo` from the UTC `valid_time`
- [ ] A calendar day table is materialised by a generator with a pinned version, holding date, UF, holiday name and category, including moveable feasts
- [ ] Regenerating at the pinned version reproduces the stored table exactly, and a non-empty diff over past dates is documented as a retrain trigger
- [ ] National holidays are a binary; regional holidays enter as the subsystem's observing-state share, labelled a proxy and explicitly unweighted by load
- [ ] Day-before-holiday and bridge-day features are derived from the same table
- [ ] `month` and `week_of_year` are absent, and the reason is recorded
- [ ] Solar zenith cosine and extraterrestrial horizontal irradiance are computed in SQL at the solar-capacity-weighted centroid
- [ ] The builder asserts exactly 24 distinct local hours per target date and fails loudly otherwise
- [ ] Fixture tests cover the cyclical encodings at hour 23→0, day-of-year 365→1 and across a leap year, and pin known holidays across several years
- [ ] Seams 1 and 2 still pass with these features present
