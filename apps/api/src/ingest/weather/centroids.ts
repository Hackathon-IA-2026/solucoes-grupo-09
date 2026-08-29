import { BadInputError } from "../../errors.js";
import type { QueryPoint, RawLocation } from "./single-runs.js";

/**
 * The frozen weather centroid set — where weather enters the platform.
 *
 * Weather is queried at **capacity-cluster centroids**, not at plants: a
 * point-query API at ~1,100 renewable plants is neither affordable nor more
 * informative than a weighted average over the clusters they sit in.
 *
 * **Points are frozen per feature-set version; weights are not.** A moving
 * query point changes the Open-Meteo grid cell underneath the series, which is
 * a silent covariate shift — the series would change because the question
 * changed, and nothing in the data would say so. Weights are
 * `CapacityWeight(centroid, technology, t)` derived from `InstalledCapacityAsOf`
 * and are therefore time-varying by construction; they live with the feature
 * builder, not here. This module owns only the geometry.
 *
 * Regenerating the set is a **new version, a new feature-set version and a
 * retrain** — never an in-place edit of the numbers below.
 */

/** Where a centroid's weight mass comes from. Weights themselves are elsewhere. */
export type CentroidTechnology = "WIND" | "SOLAR";

export interface Centroid {
  /** Stable identifier, and the business key of every weather row. */
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  technology: CentroidTechnology;
  /**
   * Installed MW the cluster represented at the 2026-08 SIGA snapshot the
   * points were computed from. Provenance for the geometry, and nothing else —
   * it is **not** the weight, which varies with time.
   */
  representedMw: number;
  /**
   * True where the coordinate was **not** computed from SIGA municipality
   * centroids the way the others were.
   *
   * Carried rather than silently smoothed over: `docs/research/weather-sources.md`
   * flags W11 and W12 as approximate and says to recompute them from the SIGA
   * CSV before use, and a flag on the row is the only form of that warning that
   * survives into a run log.
   */
  provisional: boolean;
}

/**
 * Version of the frozen geometry. Stored on every run request, so a series
 * built at one geometry can never be silently concatenated with another.
 */
export const CENTROID_SET_VERSION = "centroid_set_v1";

/**
 * v1 — the points from `docs/research/weather-sources.md`, centroids of ANEEL
 * SIGA plant coordinates aggregated by municipality.
 *
 * **Nineteen, not twenty.** The research's prose says "That is 20 points" and
 * then lists nineteen (W1–W12 and S1–S7). The list is the measured artefact and
 * the count is the typo, so nineteen is what is frozen here.
 */
export const CENTROIDS: readonly Centroid[] = [
  // NE — wind (~30.8 GW, ~91% of national wind).
  {
    id: "W1",
    label: "Morro do Chapéu / Chapada Diamantina, BA",
    latitude: -11.216,
    longitude: -41.341,
    technology: "WIND",
    representedMw: 1992,
    provisional: false,
  },
  {
    id: "W2",
    label: "Sento Sé + Campo Formoso, BA (north São Francisco)",
    latitude: -10.34,
    longitude: -41.02,
    technology: "WIND",
    representedMw: 2399,
    provisional: false,
  },
  {
    id: "W3",
    label: "Gentio do Ouro / Serra do Assuruá + Xique-Xique, BA",
    latitude: -11.15,
    longitude: -42.6,
    technology: "WIND",
    representedMw: 1955,
    provisional: false,
  },
  {
    id: "W4",
    label: "Caetité, BA (south)",
    latitude: -14.18,
    longitude: -42.574,
    technology: "WIND",
    representedMw: 921,
    provisional: false,
  },
  {
    id: "W5",
    label: "Dom Inocêncio + Lagoa do Barro do Piauí, PI",
    latitude: -8.8,
    longitude: -41.6,
    technology: "WIND",
    representedMw: 2016,
    provisional: false,
  },
  {
    id: "W6",
    label: "Simões, PI (PE border)",
    latitude: -7.644,
    longitude: -40.688,
    technology: "WIND",
    representedMw: 694,
    provisional: false,
  },
  {
    id: "W7",
    label: "Coastal-east RN: João Câmara / Lajes / Parazinho / São Bento do Norte",
    latitude: -5.4,
    longitude: -36.05,
    technology: "WIND",
    representedMw: 4172,
    provisional: false,
  },
  {
    id: "W8",
    label: "Serra do Mel, RN (coastal-west)",
    latitude: -5.292,
    longitude: -37.195,
    technology: "WIND",
    representedMw: 1200,
    provisional: false,
  },
  {
    id: "W9",
    label: "Trairi, CE (coast)",
    latitude: -3.273,
    longitude: -39.318,
    technology: "WIND",
    representedMw: 768,
    provisional: false,
  },

  // NE — solar (~11.4 GW).
  {
    id: "S1",
    label: "Açu, RN",
    latitude: -5.586,
    longitude: -37.042,
    technology: "SOLAR",
    representedMw: 1239,
    provisional: false,
  },
  {
    id: "S2",
    label: "Juazeiro, BA / Petrolina axis",
    latitude: -9.64,
    longitude: -40.615,
    technology: "SOLAR",
    representedMw: 972,
    provisional: false,
  },
  {
    id: "S3",
    label: "São Gonçalo do Gurguéia + Ribeiro Gonçalves, PI (SW Cerrado)",
    latitude: -8.9,
    longitude: -45.24,
    technology: "SOLAR",
    representedMw: 1314,
    provisional: false,
  },
  {
    id: "S4",
    label: "São José do Belmonte, PE",
    latitude: -7.897,
    longitude: -38.743,
    technology: "SOLAR",
    representedMw: 863,
    provisional: false,
  },

  // SE/CO — solar (~10.8 GW, overwhelmingly northern Minas Gerais).
  {
    id: "S5",
    label: "Janaúba + Jaíba, MG",
    latitude: -15.62,
    longitude: -43.6,
    technology: "SOLAR",
    representedMw: 3534,
    provisional: false,
  },
  {
    id: "S6",
    label: "Paracatu + Arinos, MG (northwest)",
    latitude: -16.48,
    longitude: -46.41,
    technology: "SOLAR",
    representedMw: 3051,
    provisional: false,
  },
  {
    id: "S7",
    label: "Pirapora + Várzea da Palma, MG",
    latitude: -17.47,
    longitude: -44.84,
    technology: "SOLAR",
    representedMw: 1494,
    provisional: false,
  },

  // S (~2.3 GW wind, negligible solar).
  {
    id: "W10",
    label: "Santa Vitória do Palmar, RS (far south)",
    latitude: -33.418,
    longitude: -53.156,
    technology: "WIND",
    representedMw: 628,
    provisional: false,
  },
  {
    id: "W11",
    label: "RS/SC north-coast belt (Osório and successors)",
    latitude: -29.8,
    longitude: -50.3,
    technology: "WIND",
    representedMw: 600,
    // Not computed from SIGA municipality centroids — recompute before this
    // point carries weight in a trained model.
    provisional: true,
  },

  // N (~426 MW wind, no utility solar).
  {
    id: "W12",
    label: "Maranhão coastal wind",
    latitude: -2.7,
    longitude: -42.7,
    technology: "WIND",
    representedMw: 426,
    provisional: true,
  },
];

const BY_ID = new Map(CENTROIDS.map((centroid) => [centroid.id, centroid]));

/** Resolve caller-supplied ids against the frozen set, preserving set order. */
export function resolveCentroids(ids?: readonly string[]): Centroid[] {
  if (!ids || ids.length === 0) {
    return [...CENTROIDS];
  }
  const wanted = new Set(ids);
  for (const id of wanted) {
    if (!BY_ID.has(id)) {
      throw new BadInputError(
        `Unknown centroid '${id}' — ${CENTROID_SET_VERSION} holds ${CENTROIDS.length} points`,
      );
    }
  }
  return CENTROIDS.filter((centroid) => wanted.has(centroid.id));
}

/** A centroid as the transport wants it. */
export function asQueryPoints(centroids: readonly Centroid[]): QueryPoint[] {
  return centroids.map((centroid) => ({
    id: centroid.id,
    latitude: centroid.latitude,
    longitude: centroid.longitude,
  }));
}

/** Two frozen points that resolve to one model grid cell. A build error. */
export class GridCellCollisionError extends BadInputError {
  constructor(message: string) {
    super(message);
    this.name = "GridCellCollisionError";
  }
}

/**
 * Assert that no two centroids landed in the same grid cell.
 *
 * Open-Meteo snaps a query to the nearest cell and **echoes the cell centre
 * back**, which is the only way to find this out. At 9–13 km resolution the
 * research warned that the W1/W3 and W7/W8 pairs might collapse; measured
 * against `ecmwf_ifs` on 2026-08-28 all nineteen resolve to distinct cells, and
 * this check is what keeps that true rather than assumed.
 *
 * A collision is not a rounding detail: the same cell would enter the
 * capacity-weighted average twice under two different weights, quietly
 * doubling one region's influence.
 */
export function assertNoGridCollisions(
  centroids: readonly Centroid[],
  locations: readonly Pick<RawLocation, "latitude" | "longitude">[],
): void {
  if (centroids.length !== locations.length) {
    throw new BadInputError(
      `Asked for ${centroids.length} centroids and got ${locations.length} locations back. ` +
        "The Single Runs API answers a multi-point request in request order; a " +
        "different count means the pairing by index is no longer sound.",
    );
  }
  const seen = new Map<string, string>();
  for (const [index, centroid] of centroids.entries()) {
    const location = locations[index] as (typeof locations)[number];
    const cell = `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;
    const previous = seen.get(cell);
    if (previous) {
      throw new GridCellCollisionError(
        `Centroids ${previous} and ${centroid.id} both snap to grid cell ${cell}. ` +
          "One cell weighted twice is a silently doubled region; merge the two " +
          "points and their weights, and cut a new centroid set version.",
      );
    }
    seen.set(cell, centroid.id);
  }
}
