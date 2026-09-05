#!/usr/bin/env python3
"""Write the great-circle golden vectors a third way.

There are two implementations of the great-circle distance in this repository
and there is a reason for both (``packages/core/fixtures/great-circle/README.md``).
This script is *neither* of them, and that is its whole job: the expected
kilometres in the vectors must not come from either side of the parity, or a
shared misunderstanding would cancel out and the fixture would certify it.

Both implementations use the **haversine** formula. This one uses the
**Vincenty formula specialised to a sphere** — a different expression of the
same quantity, in ``atan2`` rather than ``asin``, with no clamp and no squared
half-angles, and numerically well conditioned at both ends of the range where
haversine (near-antipodal) and the spherical law of cosines (near-coincident)
each degrade. Agreement to twelve significant figures between two formulas that
fail in different places is evidence; agreement between two spellings of the
same formula is not.

    python3 packages/core/scripts/build-great-circle-vectors.py

Rewrites every ``*.json`` in ``packages/core/fixtures/great-circle/`` from the
table below. The radius is the one thing it shares with the implementations,
because a radius is a *choice* rather than a derivation: IUGG mean Earth radius
6371.0088 km, which is what makes "kilometres" mean the same thing in three
places. It is asserted as a literal by the suites, so a fourth spelling of it
cannot appear without a failure.
"""

from __future__ import annotations

import json
from math import atan2, cos, radians, sin, sqrt
from pathlib import Path

#: IUGG mean Earth radius, in kilometres. The one shared constant. Changing it
#: here without changing both implementations is what the suites will catch.
EARTH_RADIUS_KM = 6371.0088

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "great-circle"


def vincenty_sphere_km(
    lat_a: float, lon_a: float, lat_b: float, lon_b: float
) -> float:
    """Central angle by Vincenty's sphere formula, times the radius."""
    phi_a, phi_b = radians(lat_a), radians(lat_b)
    delta_lambda = radians(lon_b - lon_a)
    numerator = sqrt(
        (cos(phi_b) * sin(delta_lambda)) ** 2
        + (cos(phi_a) * sin(phi_b) - sin(phi_a) * cos(phi_b) * cos(delta_lambda)) ** 2
    )
    denominator = sin(phi_a) * sin(phi_b) + cos(phi_a) * cos(phi_b) * cos(delta_lambda)
    return EARTH_RADIUS_KM * atan2(numerator, denominator)


#: (file stem, prose, from, to). The prose is the case, not the numbers.
CASES: list[tuple[str, str, tuple[float, float], tuple[float, float]]] = [
    (
        "01-a-plant-standing-on-its-own-centroid",
        "A plant exactly on the point it is weighted onto. The haversine's "
        "square root is taken of a value that rounds to zero and its arcsine "
        "of zero, which is the one input where a formula can return NaN "
        "instead of a distance.",
        (-9.5, -40.5),
        (-9.5, -40.5),
    ),
    (
        "02-bahia-interior-wind-to-its-cluster-centroid",
        "The normal case, at the scale the weighting actually runs at: a "
        "Bahia interior wind plant and a north-east cluster centroid, a few "
        "hundred kilometres apart.",
        (-10.4, -42.3),
        (-8.9, -40.1),
    ),
    (
        "03-two-plants-in-one-open-meteo-grid-cell",
        "Nine kilometres apart — inside one Open-Meteo cell at the pinned "
        "model's resolution. The spherical law of cosines loses most of its "
        "significant figures here, which is why neither implementation uses it.",
        (-5.2, -37.4),
        (-5.2, -37.4812),
    ),
    (
        "04-a-metre-apart",
        "Sub-kilometre, where cancellation in the cosine term is worst. A "
        "distance that came back as zero here would silently collapse two "
        "distinct plants onto one nearest-centroid tie.",
        (-9.0, -40.0),
        (-9.0, -40.00001),
    ),
    (
        "05-one-degree-of-latitude-on-the-meridian",
        "A pure north-south degree: the answer is the radius times one degree "
        "in radians and nothing else, so a transposed argument shows up as a "
        "different number rather than as a plausible one.",
        (0.0, 0.0),
        (1.0, 0.0),
    ),
    (
        "06-one-degree-of-longitude-at-the-solar-fleets-latitude",
        "The same degree east-west at −16°, where it is shortened by the "
        "cosine. Paired with the case above, it pins which argument is which: "
        "an implementation that swapped latitude for longitude passes one and "
        "fails the other.",
        (-16.0, -44.0),
        (-16.0, -43.0),
    ),
    (
        "07-across-the-antimeridian",
        "±180° apart in the longitude column while a few hundred kilometres "
        "apart on the globe. An implementation that subtracted the longitudes "
        "without letting the trigonometry wrap reports most of the planet.",
        (-9.0, 179.5),
        (-9.5, -179.5),
    ),
    (
        "08-the-north-pole-to-the-equator",
        "A quarter of a meridian, where cos(phi) is zero at one end.",
        (90.0, 0.0),
        (0.0, -41.0),
    ),
    (
        "09-nearly-antipodal",
        "The far end of the range, where the haversine's arcsine argument "
        "approaches one and its clamp is the only thing between the formula "
        "and a domain error.",
        (-9.5, -40.5),
        (9.4, 139.5),
    ),
    (
        "10-the-two-frozen-centroids-that-nearly-collided",
        "Two points close enough to raise the grid-collision question the "
        "centroid generator answers, far enough apart to be two cells.",
        (-9.0, -40.0),
        (-8.87, -39.91),
    ),
]


def main() -> None:
    for stem, why, (lat_a, lon_a), (lat_b, lon_b) in CASES:
        payload = {
            "name": stem,
            "why": why,
            "from": {"latitude": lat_a, "longitude": lon_a},
            "to": {"latitude": lat_b, "longitude": lon_b},
            "expected_km": vincenty_sphere_km(lat_a, lon_a, lat_b, lon_b),
        }
        path = FIXTURES / f"{stem}.json"
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"{path.name}: {payload['expected_km']!r}")


if __name__ == "__main__":
    main()
