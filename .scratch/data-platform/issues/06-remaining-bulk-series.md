# 06 — Remaining subsystem bulk series: interchange and daily load

**What to build:** WattSteer knows the directed power flows between subsystems and
the daily load series, completing the system-context picture the forecaster needs.

These are two more bulk adapters over machinery that already exists, but each
carries a specific hazard worth its own attention.

The interchange dataset gained a column that was **not** backfilled into closed
years — the opposite behaviour from the constrained-off datasets in ticket 02, and
proof that neither behaviour can be assumed for the next dataset.

The daily load series has two documented changes in what it *means*, with no schema
change to signal them. A level shift there must be recorded as a methodology break,
not modelled as a change in the grid.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Directed interchange flows are ingested, both verified and programmed where present
- [ ] Years missing the later column ingest cleanly, without failing and without defaulting
- [ ] Leading whitespace in subsystem names is handled
- [ ] The daily load series is ingested with its definitional regimes recorded as metadata
- [ ] Interval labelling is normalised to match every other source
- [ ] Change detection still works where the catalogue does not report a modification time
