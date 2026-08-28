# 08 — The operational day-ahead balance, stored as a forecast

**What to build:** WattSteer holds ONS's own day-ahead expectation of load and
generation per subsystem — the operational forecast the curtailment model layers
intelligence on top of, rather than reproducing from scratch.

The distinguishing feature is temporal. This is a forecast published by ONS, so it
has three time axes: the time it describes, the time ONS published it, and the time
WattSteer ingested it. Storing it beside actuals with a horizon column would
conflate a forecast with an observation, so it gets its own home.

Files are split per reference day rather than per month or year, unlike every other
source. The period index has no documented mapping to wall-clock time — the mapping
is inferred, so it must be asserted on ingest rather than trusted.

**Blocked by:** 01

**Status:** done

- [x] The detailed balance is ingested — the only forward-looking wind and solar dispatch expectation available
- [x] Daily-split file discovery works and backfills the full available history
- [x] Three time axes are stored; the data can never be read as an observation
- [x] The period index is mapped to wall-clock time, and the mapping is asserted rather than assumed
- [x] A reference day with an unexpected number of periods is rejected loudly
- [x] The published header is trusted over the data dictionary where the two disagree
- [x] Values are treated as instantaneous power, matching the source, not as average power
