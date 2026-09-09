# 16 — The ingestion horizon is one instant, and it over-relaxes

**What to build:** an ingestion cut that is honest per source, not per deployment.

Feature-engineering 15 fixed the gate's `as_of`, which had been filtering
everything: over a backfill, `ingested_at` is the loader's clock and cutting on it
emptied the read. The fix relaxes the ingestion cut where WattSteer has no
ingestion history to be honest about — correct, and it left a cost the ticket did
not ask about and the implementer recorded rather than hid:

> A single session axis cannot carry a per-source floor, so the horizon is the
> **latest** go-live — which over-relaxes for sources that were already live
> during the onboarding band.

So for a target date inside the onboarding band, a source that *was* already
ingesting gets its cut relaxed when it need not be. The read then sees rows that
were not knowable at the gate, and the row is stamped `revision_optimistic` to
say so. **The stamp is honest; the read is still more optimistic than it has to
be**, and the affected window is exactly the early history a first model is
fitted on.

Closing this means a floor per source rather than one for the deployment. Weigh
the shapes: several GUCs, one composite value, or the cut moving inside the view
that knows which source a row came from. `canonical_read_go_live` already holds
the per-source instants — the information exists; only the axis is too narrow to
carry it.

**Do not trade this for the invariant.** `feature_rows` must still accept no
instant from a caller, and `published_at_or_before` must remain the gate
unconditionally. Feature-engineering 15 has tests for both, including a
`pg_get_function_arguments` check on the live server; they must keep passing.

**If the honest answer is that per-source floors cost more than the optimism is
worth, that is a legitimate result** — say it with the measurement: how many
rows, over which window, currently read as `revision_optimistic` that a per-source
floor would make `point_in_time`. Do not close it on taste.

**Blocked by:** feature-engineering 15 (merged).

**Status:** ready-for-agent

- [ ] The size of the problem is measured before it is fixed
- [ ] If fixed: sources already live get their own floor, and rows that become
      genuinely point-in-time are stamped that way rather than staying optimistic
- [ ] `feature_rows` still accepts no instant; the publication cut is untouched
- [ ] `feature_hash` movement is reported prominently either way — the tree is
      already carrying `0039`'s retrain debt and a second cause must not be silent
- [ ] If not fixed: the measurement and the reason are recorded on this ticket
