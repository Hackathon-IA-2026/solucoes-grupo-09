# 02 — The centroid set, generated from the registry and frozen

**What to build:** the twenty points where weather enters WattSteer are produced
by a script from the plant registry rather than transcribed by hand, frozen for
the life of a feature-set version, and watched for the day the fleet grows away
from them.

The points currently in the codebase were transcribed from research, and two of
them — the RS/SC north-coast point and the MA coastal point — were never
computed from SIGA municipality centroids at all. Generating the whole set makes
that automatic, makes the set reproducible, and makes regeneration a reviewable
diff rather than an edit.

The discipline the generator enforces is the one that is easy to lose:
**points are frozen, weights are not**. A moving query point changes the
Open-Meteo grid cell underneath the series, which is a silent covariate shift; a
moving weight is exactly what the registry research measured as mandatory —
fixed present-day weights misallocate half the SE-solar weight mass at window
start and move that centroid seven grid cells. `CapacityWeight(centroid,
technology, t)` stays a function of the target date and is not this ticket's.

Two centroids that snap to the same Open-Meteo grid cell are a **build error**,
not a warning: the column would be averaged in twice under different weights.
Open-Meteo echoes the snapped coordinates, so the generator can see the
collision and merge the colliding points, summing their weights, before
freezing.

Regeneration is never an in-place edit. A drift trigger produces a new centroid
set version, which is a new feature-set version and a retrain.

This runs independently of the feature function — it is registry and ingest
work, and the weather feature block can be built against the existing frozen set
while this lands.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The centroid set is generated from the plant registry and SIGA coordinates by a script, and regenerating it reproduces the stored set exactly
- [ ] Every point is derived, including the two that were never computed from municipality centroids
- [ ] Colliding grid cells are detected, merged with their weights summed, and asserted unique before the set is frozen
- [ ] The set carries a version identifier; the geometry is immutable once frozen and a change cuts a new version
- [ ] The generator records the capacity-weighted mean plant-to-centroid distance at freeze time
- [ ] A scheduled job recomputes that distance and raises a regeneration trigger at a 25% increase
- [ ] Regeneration is documented as a new centroid set version, a new feature-set version and a retrain — never an in-place edit
