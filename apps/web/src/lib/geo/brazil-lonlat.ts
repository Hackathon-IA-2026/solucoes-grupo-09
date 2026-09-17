/**
 * The four subsystem outlines as longitude/latitude, recovered from the 2D map.
 *
 * ## Why this inverts a projection instead of fetching geometry
 *
 * The globe needs the same four regions the SVG map draws, in geographic
 * coordinates. The obvious route is to fetch IBGE's mesh again and group the
 * federal units a second time — and that is exactly the wrong move, because the
 * grouping is the part that carries the product's meaning. ONS's subsystems are
 * **electrical**, not geographic: Maranhão is in Norte, Acre and Rondônia are in
 * Sudeste/Centro-Oeste, and Roraima is in no subsystem at all. Those assignments
 * are argued and cited in `./brazil-subsystems.ts`. A second copy of them, made
 * independently for the globe, is a second thing to get wrong — and the failure
 * would be silent and plausible, a state quietly lit the wrong colour on one of
 * two maps.
 *
 * So there is one source of the shapes. `BRAZIL_PROJECTION` documents an
 * equirectangular projection with a standard parallel at 15° S, which is a pure
 * function of two scalars and therefore exactly invertible:
 *
 *     x = (lon · cos φ − lon0) · scale        lon = (x / scale + lon0) / cos φ
 *     y = (−lat − lat0) · scale               lat = −(y / scale + lat0)
 *
 * Round-tripping costs nothing and guarantees the globe and the map disagree
 * about nothing, by construction rather than by review.
 *
 * ## What the coordinates are and are not
 *
 * They are the **simplified** boundaries — the topology described in
 * `./brazil-geometry.ts`, quantised and emitted at one decimal place of viewBox
 * pixel, which is roughly 4 km on the ground. That is right for this screen and
 * would be wrong for another: a region is filled by a risk class and clicked, so
 * a 4 km error on a coastline is invisible at every altitude the camera flies
 * to. Nothing here should ever be used to decide which side of a border a plant
 * is on.
 *
 * Islands under about 1.5 px were dropped upstream; Fernando de Noronha is
 * absent, which is correct anyway — it is a Sistema Isolado and belongs to no
 * subsystem.
 */

import type { SubsystemCode } from "@wattsteer/core";
import { BRAZIL_PROJECTION, SUBSYSTEM_PATH_D } from "./brazil-geometry";

const COS_PHI = Math.cos((BRAZIL_PROJECTION.standardParallelDeg * Math.PI) / 180);

/** One viewBox point back to `[longitude, latitude]` in degrees. */
export function unproject(x: number, y: number): [number, number] {
  return [
    (x / BRAZIL_PROJECTION.scale + BRAZIL_PROJECTION.lon0) / COS_PHI,
    -(y / BRAZIL_PROJECTION.scale + BRAZIL_PROJECTION.lat0),
  ];
}

/**
 * The generated paths use `M` and `L` and nothing else — no curves, no relative
 * commands, no `Z`. That is a property of the generator, so parsing is a split
 * rather than a path parser, and anything else in the string is a signal that
 * the generator changed and this module needs revisiting rather than patching.
 */
const COMMAND = /([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g;

/**
 * A subsystem's outline as closed rings of `[lon, lat]`.
 *
 * Several rings because a subsystem is not one polygon: Norte has Marajó and
 * the Amazon delta, Sul has the Lagoa dos Patos coast. Each `M` opens a new
 * one.
 */
export function subsystemRings(code: SubsystemCode): [number, number][][] {
  const rings: [number, number][][] = [];
  let current: [number, number][] | null = null;

  for (const [, command, rawX, rawY] of SUBSYSTEM_PATH_D[code].matchAll(COMMAND)) {
    const point = unproject(Number(rawX), Number(rawY));
    if (command === "M") {
      current = [point];
      rings.push(current);
    } else {
      // A stray `L` before any `M` would mean the path string is malformed;
      // there is no sensible ring to add it to, so it is dropped rather than
      // silently opening one that starts in the wrong place.
      current?.push(point);
    }
  }

  /*
    Rings of fewer than three points are not polygons. They survive the
    simplification as degenerate fragments of dropped islands, and Cesium
    answers one by throwing while building a geometry — which would take the
    whole globe down over a sliver nobody can see.
  */
  return rings.filter((ring) => ring.length >= 3);
}

/**
 * The flat `[lon, lat, lon, lat, …]` Cesium's `Cartesian3.fromDegreesArray`
 * wants, per ring. Kept here rather than in the component so the component has
 * no geometry logic in it at all.
 */
export function subsystemRingsFlat(code: SubsystemCode): number[][] {
  return subsystemRings(code).map((ring) => ring.flat());
}
