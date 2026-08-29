# 11 — Tiered refresh, raw-payload custody and observability

**What to build:** WattSteer keeps itself current, keeps its own history, and can be
seen to be doing both.

The refresh regime matches the revision behaviour actually observed: recent periods
change constantly, while closed periods look settled but are rewritten in bulk
campaigns years later. The slow sweep over closed history is the only thing that
catches those campaigns, and they are the highest-impact revisions precisely
because they silently restate data everyone has stopped watching.

Custody matters because the source publishes no version marker and offers no way to
request a prior vintage. Once a file is overwritten, what it used to say is gone
unless WattSteer kept it. Every backtest that claims to be point-in-time depends on
this having been running since go-live.

**Blocked by:** 01

**Status:** done

- [x] Refresh is tiered by period volatility, with a slow sweep across all closed history
- [x] A bulk re-publication of closed periods is detected and surfaced, not silently absorbed
- [x] Raw payloads are archived byte-for-byte with their fetch time
- [x] Archived payloads can be reprocessed without re-fetching
- [x] A retention policy exists and is enforced
- [x] A per-source view shows freshness, row counts and last successful run
- [x] Registry join match rates appear in that view
- [x] A source that quietly stops updating becomes visible rather than silently going stale
