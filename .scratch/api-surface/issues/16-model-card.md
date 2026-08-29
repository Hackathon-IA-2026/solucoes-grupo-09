# 16 — Model metadata is a separate call, because it is not a property of a day

**What to build:** the endpoint the Explain screen reads for the reliability
curve and the model's headline numbers: the curve and its sample counts, the
window and fidelity it was measured over, the calibration error metrics, the top
bin gap, the risk bins, the band's calibration deltas, the headline metrics per
fold, the baseline-ladder deltas, and the lane's identity with its training and
calibration windows.

**It is separate from the diagnosis on the forecaster's own grounds**: the curve
is a property of the *model*, not of a day. Folding it into the per-day payload
would give a weekly-changing object a daily cache key, and would put the same
tens of kilobytes on the wire on every Explain view.

The full card is large, so this endpoint returns the **product-facing subset**
plus a URL pointing at the raw card for anyone auditing.

Note for the implementer: the Explain screen currently gets its reliability data
from the same fixture as its drivers. Splitting it into two calls is a real
screen change and is part of this ticket.

**Blocked by:** 04. Cross-spec: **forecaster** owns the card's content and the
lane states; this ticket exposes a subset of it and decides nothing about what is
in it.

**Status:** ready-for-agent

- [ ] One request returns the product-facing card subset for a named lane
- [ ] The reliability window and its vintage fidelity are on the response and nothing averages across fidelity
- [ ] The raw card is reachable by URL for auditing
- [ ] The Explain screen reads its curve from this route, not from the diagnosis response
- [ ] The response changes only on promotion, and its cache identity is the artifact's
- [ ] With no promoted artifact in the requested lane, the model-unavailable code is returned with the lane state in the details
