"""The horizon: the 24 hours whose local civil date is the Scenario's target.

Storage stays UTC and so does every ``valid_time``. Local indexing exists only
here, at the model boundary, because "the battery is available 11:00–18:00" is a
statement an operator makes in Brasília time, not in UTC.

The hours are derived from the IANA zone rather than a fixed ``-03:00`` offset,
and the count is asserted. Brazil's last DST transition predates the data window
(which opens 2024-04), so no 23- or 25-hour day exists in range — but a zone
database that says otherwise should stop the solve, not silently shorten the
day and quietly change every hour index after the transition.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from .errors import OptimizerBugError

#: The grid's civil clock. One zone, because ONS publishes one.
GRID_ZONE = ZoneInfo("America/Sao_Paulo")

#: ``T`` — the number of periods v1 ships. The model below is period-agnostic;
#: the research measured a 96-period 15-minute horizon at 63 ms and it is a
#: parameter change, not a reformulation.
HORIZON_HOURS = 24

#: ``Δt``, hours. At 1 h, MW and MWh are numerically interchangeable, which is
#: why the formulation can write power limits and energy totals in one sum.
PERIOD_HOURS = 1.0

_ONE_HOUR = timedelta(hours=1)


@dataclass(frozen=True)
class Horizon:
    """One local civil day, as UTC instants."""

    target_date: date
    zone_key: str
    #: The UTC instant each local hour starts at, ``t = 0…23``.
    starts_at: tuple[datetime, ...]

    def __len__(self) -> int:
        return len(self.starts_at)

    @property
    def hours(self) -> range:
        """The local hour indices, ``t = 0…23``."""
        return range(len(self.starts_at))


def local_day(target_date: date, zone: ZoneInfo = GRID_ZONE) -> Horizon:
    """The hours of ``target_date`` as read on ``zone``'s civil clock.

    Raises :class:`OptimizerBugError` if the day is not exactly
    :data:`HORIZON_HOURS` whole hours long — a DST transition inside the
    horizon is out of range for this product and must not be absorbed silently.
    """
    starts = datetime.combine(target_date, time(0), tzinfo=zone).astimezone(UTC)
    ends = datetime.combine(
        target_date + timedelta(days=1), time(0), tzinfo=zone
    ).astimezone(UTC)
    span = ends - starts
    if span % _ONE_HOUR or span // _ONE_HOUR != HORIZON_HOURS:
        raise OptimizerBugError(
            f"{target_date.isoformat()} is {span} long on {zone.key}, "
            f"not {HORIZON_HOURS} whole hours."
        )
    return Horizon(
        target_date=target_date,
        zone_key=zone.key,
        starts_at=tuple(starts + hour * _ONE_HOUR for hour in range(HORIZON_HOURS)),
    )
