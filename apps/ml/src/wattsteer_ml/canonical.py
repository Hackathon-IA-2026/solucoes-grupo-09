"""The canonical read contract, from the consuming side.

**This module is why the modelling service never reads a fact table.** The
platform owns ONS's conventions and resolves every one of them at ingest; what
reaches here is WattSteer's own vocabulary, served by the canonical **views**
(`apps/api/src/database/canonical-views.ts`) and read by
:mod:`wattsteer_ml.canonical_reads` on this service's own read-only role. A
padded subsystem code, an average-power value, a `SIN` aggregate row and an
end-of-interval timestamp are all things this side has never seen and has no
code to handle.

Ticket 016 is what makes that sentence true rather than aspirational. While the
contract was TypeScript it could only reach Python over HTTP, so this module
carried a URL builder and the modelling side called the gateway; the views moved
the definition somewhere both languages can hold it, and the URL builder is gone
with the need for it. **This service has no HTTP client and must never grow
one.**

What lives here is the half of the contract that has to exist in *both*
languages:

* :data:`CANONICAL_READS` — the vocabulary. Which reads exist, at what grain,
  keyed by what, observation or forecast, and whether a restriction cause is
  reachable from them.
* :func:`vintage_fidelity` and :func:`combine_fidelity` — the rule that decides
  whether an answer is honestly point-in-time. It is four lines of arithmetic
  over two instants and it decides whether a backtest number means anything,
  which is exactly the kind of rule two languages get subtly different.

  This is the **one** thing ticket 016 deliberately left duplicated. Everything
  that shapes a row moved into SQL; an inequality between two timestamps did
  not, because the golden vectors already bind the two implementations and
  because pushing it into the database would cost the one part of this contract
  that is testable without one. The database supplies its input — the go-live
  instant, from ``canonical_read_go_live`` — and nothing else.

Neither is copied from the TypeScript at runtime; both are asserted against the
shared golden vectors in ``packages/core/fixtures/canonical-contract/``, which
``apps/ml/tests/test_canonical_contract.py`` and
``packages/core/test/canonical-contract.test.ts`` both enumerate. Each side
asserts against ``expected`` and never against the other, so a shared
misunderstanding cannot cancel out.

`docs/contracts/canonical-reads.md` is the document; `docs/domain-model.md` is
the authority for every name.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

#: Observation or forecast, decided structurally rather than by a flag.
#: `docs/domain-model.md` §4: an Observation always has
#: ``published_at > valid_time``; a Forecast always has
#: ``published_at < valid_time`` and additionally names the run that produced it.
FactKind = Literal["observation", "forecast"]

#: The producers whose runs the platform stores.
ForecastProducer = Literal["open_meteo", "ons_dessem", "wattsteer"]

#: Whether an as-of read is honestly point-in-time. Product-visible, not
#: internal: any surface reporting a metric over a ``revision_optimistic``
#: window must say so.
VintageFidelity = Literal["point_in_time", "revision_optimistic"]

#: Where the contract is served. Mirrors ``CANONICAL_BASE_PATH`` in
#: ``apps/api/src/contract/manifest.ts``.
CANONICAL_BASE_PATH = "/v1/canonical"


@dataclass(frozen=True)
class CanonicalRead:
    """One read, described completely enough that a consumer never guesses."""

    name: str
    kind: FactKind
    #: ``None`` for an observation — there is no run that produced one.
    producer: ForecastProducer | None
    grain: str
    #: The business key. An as-of read returns exactly one row per key, or none.
    key: tuple[str, ...]
    #: True for exactly one read. `docs/domain-model.md` §3: a restriction
    #: reason is a property of a ReportingEntity, and there is no path from a
    #: Plant to one. A second ``True`` here would mean that path had opened.
    carries_restriction_cause: bool
    #: Which axis decides this read's fidelity — the valid-time window for a
    #: fact table, the fleet date for a registry read.
    fidelity_axis: Literal["valid_time", "as_of", "fleet_date"]


#: Every read the contract exposes, in the order the modelling side meets them.
#:
#: The five families the platform owes the modelling side — curtailment
#: observations, system context, the operational day-ahead balance, weather and
#: the registry with as-of capacity — expand to eight reads because two of them
#: are genuinely two grains.
CANONICAL_READS: tuple[CanonicalRead, ...] = (
    CanonicalRead(
        name="curtailment-by-reporting-entity",
        kind="observation",
        producer=None,
        grain="reporting_entity_hour",
        key=("reportingEntityCode", "technology", "validTime"),
        carries_restriction_cause=True,
        fidelity_axis="valid_time",
    ),
    CanonicalRead(
        name="curtailment-by-plant",
        kind="observation",
        producer=None,
        grain="plant_hour",
        key=("plantOnsCode", "technology", "validTime"),
        carries_restriction_cause=False,
        fidelity_axis="valid_time",
    ),
    CanonicalRead(
        name="system-context",
        kind="observation",
        producer=None,
        grain="subsystem_hour",
        key=("subsystem", "validTime"),
        carries_restriction_cause=False,
        fidelity_axis="valid_time",
    ),
    CanonicalRead(
        name="system-exchange",
        kind="observation",
        producer=None,
        grain="subsystem_link_hour",
        key=("fromSubsystem", "toSubsystem", "validTime"),
        carries_restriction_cause=False,
        fidelity_axis="valid_time",
    ),
    CanonicalRead(
        name="day-ahead-balance",
        kind="forecast",
        producer="ons_dessem",
        grain="subsystem_half_hour",
        key=("subsystem", "validTime"),
        carries_restriction_cause=False,
        fidelity_axis="valid_time",
    ),
    CanonicalRead(
        name="weather-forecast",
        kind="forecast",
        producer="open_meteo",
        grain="centroid_hour",
        key=("centroidId", "validTime"),
        carries_restriction_cause=False,
        fidelity_axis="valid_time",
    ),
    CanonicalRead(
        name="installed-capacity",
        kind="observation",
        producer=None,
        grain="fleet_scope_day",
        key=("subsystem", "technology"),
        carries_restriction_cause=False,
        fidelity_axis="fleet_date",
    ),
    CanonicalRead(
        name="conjunto-membership",
        kind="observation",
        producer=None,
        grain="plant_day",
        key=("plantOnsCode",),
        carries_restriction_cause=False,
        fidelity_axis="fleet_date",
    ),
)

CANONICAL_READ_BY_NAME: dict[str, CanonicalRead] = {
    read.name: read for read in CANONICAL_READS
}


def vintage_fidelity(
    window_start: datetime, go_live_at: datetime | None
) -> VintageFidelity:
    """Whether a window is honestly point-in-time.

    A window is point-in-time when its **earliest** valid instant is at or after
    the first row WattSteer ever ingested for that source. The window *start*
    and not its end, because fidelity is a property of the weakest hour in the
    window: one pre-go-live hour makes the whole answer a restatement.

    ``go_live_at is None`` means the source has ingested nothing at all, which
    is ``revision_optimistic`` — an empty table cannot have been watching.
    """
    if go_live_at is None:
        return "revision_optimistic"
    return "point_in_time" if window_start >= go_live_at else "revision_optimistic"


@dataclass(frozen=True)
class VintageSource:
    """One source's contribution to a composed answer."""

    read: str
    vintage_fidelity: VintageFidelity
    go_live_at: datetime | None


def combine_fidelity(sources: list[VintageSource]) -> VintageFidelity:
    """Fidelity of an answer composed from several reads — the weakest link.

    A bundle assembled from a point-in-time curtailment series and a
    revision-optimistic weather series is revision-optimistic as a whole,
    because a consumer cannot use half of it. An **empty** list is
    ``revision_optimistic`` and not vacuously point-in-time: no source was
    consulted, so nothing was knowable.
    """
    if not sources:
        return "revision_optimistic"
    if all(source.vintage_fidelity == "point_in_time" for source in sources):
        return "point_in_time"
    return "revision_optimistic"


def combine_go_live(sources: list[VintageSource]) -> datetime | None:
    """The instant from which the whole composition would have been knowable.

    ``None`` when any source has never ingested anything: there is then no such
    instant, and reporting the maximum of the others would name a date at which
    the answer still would not have been knowable.
    """
    if not sources:
        return None
    latest: datetime | None = None
    for source in sources:
        if source.go_live_at is None:
            return None
        if latest is None or source.go_live_at > latest:
            latest = source.go_live_at
    return latest


# There is deliberately no URL builder in this module any more.
#
# Ticket 013 left one here — a `read_url` that composed a gateway base URL with
# a read's path — against the day the modelling side would call `/v1/canonical`
# over HTTP. Ticket 016 settled that it never will: the contract is SQL views,
# and `canonical_reads.py` reads them on this service's own read-only role. The
# builder was the last thing in `apps/ml` shaped like an HTTP client, and a
# dead one is an invitation. `CANONICAL_BASE_PATH` survives it because the
# routes themselves survive — for the web app and for debugging — and because
# the shared manifest vector still pins the path both languages agree on.
