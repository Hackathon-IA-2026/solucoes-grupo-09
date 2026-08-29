# 14 — The observed record, at the grain it was actually recorded at

**What to build:** three read routes for what happened, all of which work with no
model and no modelling service: the hourly series, the episode view, and the
restriction reasons.

**Hours** returns observations at (subsystem, technology, valid time) grain with
the vintage fidelity and the data version the rows were read at. The range is
capped at 400 days.

**Episodes** returns the **read-time view** — episodes are computed from a
parameterised SQL function and never stored, because persisting them would freeze
a threshold into the database and let two screens disagree about what an episode
is. Every episode carries the threshold and the gap tolerance that produced it,
and both are echoed at the top level too, so a screen cannot render an episode
list beside a threshold it did not use. The defaults are 5 MW and 0 hours.

**Reasons** returns observed restriction causes at reporting-entity grain. Three
rules, each because getting it wrong is a specific dishonesty:

- **The grain is required on every row** — conjunto or self-reporting plant.
  Screens label the grain rather than assuming it, because for a Tipo II-C plant
  the reason is genuinely unknown at plant grain while for the eighteen
  self-reporting plants it is genuinely observed there.
- **Nothing is aggregated to plant grain and there is no plant parameter.**
  Deriving a plant's reason from its conjunto is an allocation, and v1 computes
  none.
- **The mixed-cause flag is surfaced**, because the schema already records that
  an hour changed cause mid-way, and hiding it would make the single stored
  reason look like an observation rather than a simplification.

Reason codes are the identifier; the English gloss is a translation key and is
not returned.

**Blocked by:** 04. Also **data-platform 16** (in flight) — these routes read
the canonical views, and the reporting-entity kind becoming reachable from a
curtailment row without a second call is part of that ticket, which is what makes
the required grain field cheap.

**Status:** done

- [x] The three routes return 200 with the modelling service unreachable and no promoted artifact
- [x] The hourly range is capped at 400 days, refused with the range code beyond that
- [x] Every episode carries the threshold and the gap tolerance that produced it, echoed at the top level
- [x] Episodes are computed on read; nothing is stored at episode grain
- [x] Every reason row carries its grain, and a screen can tell a conjunto row from a plant row without a second call
- [x] There is no plant parameter and nothing is aggregated to plant grain
- [x] The mixed-cause flag is present on every reason row
- [x] Reason codes are returned as codes; no gloss appears on the wire
- [x] Every response carries its vintage fidelity and the data version it was read at
