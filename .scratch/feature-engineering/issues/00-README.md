# Feature engineering — the ticket graph

Thirteen tickets. The spine is `gate_at(target_date, gate_profile)`: ticket 01
establishes it end to end for one feature, and every later ticket inherits it
rather than re-deciding it. That is why 01 gates almost everything — not
caution, but the fact that a feature built against any other cutoff is a
train/serve skew bug that no later test would catch.

## External blocker

**data-platform 16** — the canonical read contract becomes SQL views that
`apps/ml` reads directly. Ticket 01 is its first consumer. Everything behind 01
inherits that edge.

## Can start immediately

- **02 — centroid set from the registry.** The only ticket with no blocker at
  all: it reads SIGA and the plant registry, both merged. It does not touch the
  gate, so it can run alongside data-platform 16.

## The graph

```
data-platform 16 ──► 01 gate, end to end
                      ├──► 03 calendar, holidays, astronomy
                      ├──► 04 installed capacity at the gate
                      ├──► 05 lagged actuals behind the cutoff
                      ├──► 06 ONS day-ahead programming
                      ├──► 07 DESSEM + the feature-set argument   (also 04)
                      └──► 08 the weather block                   (also 03, 04)

06 + 08 ──► 09 proxy residual load
05 + 07 ──► 10 interchange utilisation proxy
05 + 06 ──► 12 publication-lag conformance

03,04,05,06,07,08,09,10 ──► 11 both feature sets and the dictionary
08 + 11 ──► 13 the two weather experiments

02 (independent) ──► feeds 08's centroid geometry but does not gate it
```

## Parallel waves

| Wave | Tickets | Notes |
|---|---|---|
| now | **02** | independent of everything |
| after dp-16 | **01** | the spine; nothing else can be trusted before it |
| after 01 | **03, 04, 05, 06** | four ways, fully independent of each other |
| then | **07** (needs 04), **08** (needs 03, 04) | two ways |
| then | **09** (06, 08), **10** (05, 07), **12** (05, 06) | three ways |
| close | **11** | the ticket that closes the spec — every block must exist |
| last | **13** | needs 11 to have something to train twice on |

Widest point is the four-way fan after 01. Nothing in this graph is blocked on
the forecaster, the optimizer or the API.
