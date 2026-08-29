import { describe, expect, it } from "bun:test";
import { computeCapacityWeights, haversineKm } from "../src/features/index.js";
import {
  assertGeneratedCellsUnique,
  DEFAULT_CLUSTER_RADIUS_KM,
  DEFAULT_MIN_CLUSTER_MW,
  type GeneratedCentroid,
  type GeneratorPlant,
  generateCentroidSet,
  measureCentroidDistance,
  pointKey,
} from "../src/ingest/index.js";
import type { Coordinate } from "../src/ingest/types.js";
import { CENTROIDS, GridCellCollisionError } from "../src/ingest/weather/centroids.js";

// The generator's whole claim is that the frozen geometry is *computed* rather
// than transcribed, and every failure mode is quiet: a set that differs between
// two runs on the same registry is not a set anybody can review, and two points
// in one grid cell weight a region twice while producing perfectly plausible
// weather. So the tests are about determinism, provenance and collisions, and
// the fleet they run on is built by hand with known answers.

const plant = (
  cegCore: string,
  overrides: Partial<GeneratorPlant> = {},
): GeneratorPlant => ({
  cegCore,
  subsystem: "NE",
  technology: "WIND",
  capacityMw: 100,
  coordinate: { latitude: -5, longitude: -37 },
  locationSource: "siga_coordinate",
  municipality: { name: "João Câmara", uf: "RN" },
  ...overrides,
});

/**
 * A grid coarse enough to force the collisions the merge path exists for.
 *
 * 0.5° is far coarser than ECMWF IFS's 9–13 km, deliberately: the measured fact
 * is that no pair of `centroid_set_v1` points collides on the real grid, so a
 * real grid would exercise nothing. This stands in for Open-Meteo's echo, which
 * is the only authority on the real one.
 */
const coarseGrid =
  (step: number) =>
  (point: Coordinate): Coordinate => ({
    latitude: Math.round(point.latitude / step) * step,
    longitude: Math.round(point.longitude / step) * step,
  });

/** Answer every pending probe with the stand-in grid, until nothing is pending. */
function generateWithGrid(
  version: string,
  plants: readonly GeneratorPlant[],
  step: number,
  options: { clusterRadiusKm?: number; minClusterMw?: number } = {},
) {
  const snap = coarseGrid(step);
  const cells = new Map<string, Coordinate>();
  let set = generateCentroidSet(version, plants, {
    ...options,
    observedGridCells: cells,
  });
  for (let round = 0; round < 4 && set.pendingProbe.length > 0; round += 1) {
    for (const point of set.pendingProbe) {
      cells.set(pointKey(point), snap(point));
    }
    set = generateCentroidSet(version, plants, { ...options, observedGridCells: cells });
  }
  return set;
}

describe("centroid generator · derivation", () => {
  it("puts a cluster's point at the capacity-weighted mean of its plants", () => {
    // Two plants in one municipality, 3:1 by MW. The point sits three-quarters
    // of the way towards the larger one, not halfway: a cluster's point belongs
    // where its megawatts are.
    const set = generateWithGrid(
      "test_v1",
      [
        plant("A", { capacityMw: 300, coordinate: { latitude: -5, longitude: -37 } }),
        plant("B", { capacityMw: 100, coordinate: { latitude: -5.4, longitude: -37 } }),
      ],
      0.5,
    );
    expect(set.centroids).toHaveLength(1);
    expect(set.centroids[0]?.latitude).toBeCloseTo(-5.1, 6);
    expect(set.centroids[0]?.longitude).toBeCloseTo(-37, 6);
    expect(set.centroids[0]?.representedMw).toBe(400);
    // Derived, every one of them — the thing v1's W11 and W12 are not.
    expect(set.centroids.every((point) => point.provisional === false)).toBe(true);
  });

  it("never puts wind and solar in one cluster", () => {
    const set = generateWithGrid(
      "test_v1",
      [
        plant("W", { capacityMw: 500 }),
        plant("S", {
          capacityMw: 500,
          technology: "SOLAR",
          coordinate: { latitude: -5.02, longitude: -37.01 },
          municipality: { name: "Açu", uf: "RN" },
        }),
      ],
      // A grid fine enough that the two points do not share a cell — the
      // question here is clustering, not collisions.
      0.001,
    );
    expect(set.centroids.map((point) => point.technology).sort()).toEqual([
      "SOLAR",
      "WIND",
    ]);
  });

  it("separates municipalities further apart than the linkage radius", () => {
    const set = generateWithGrid(
      "test_v1",
      [
        plant("A", { capacityMw: 500 }),
        plant("B", {
          capacityMw: 500,
          municipality: { name: "Caetité", uf: "BA" },
          // ~780 km south — far outside the 75 km radius.
          coordinate: { latitude: -12, longitude: -37 },
        }),
      ],
      0.001,
    );
    expect(set.centroids).toHaveLength(2);
  });

  it("joins municipalities inside the linkage radius into one point", () => {
    const set = generateWithGrid(
      "test_v1",
      [
        plant("A", { capacityMw: 500 }),
        plant("B", {
          capacityMw: 500,
          municipality: { name: "Parazinho", uf: "RN" },
          // ~55 km east, inside 75 km.
          coordinate: { latitude: -5, longitude: -36.5 },
        }),
      ],
      0.001,
    );
    expect(set.centroids).toHaveLength(1);
    expect(set.centroids[0]?.municipalities.sort()).toEqual([
      "João Câmara, RN",
      "Parazinho, RN",
    ]);
  });
});

describe("centroid generator · determinism", () => {
  const fleet: GeneratorPlant[] = [
    plant("A", { capacityMw: 500 }),
    plant("B", {
      capacityMw: 700,
      municipality: { name: "Caetité", uf: "BA" },
      coordinate: { latitude: -14.18, longitude: -42.574 },
    }),
    plant("C", {
      capacityMw: 600,
      technology: "SOLAR",
      municipality: { name: "Janaúba", uf: "MG" },
      subsystem: "SE",
      coordinate: { latitude: -15.62, longitude: -43.6 },
    }),
  ];

  it("reproduces itself exactly on a second run over the same fleet", () => {
    const first = generateWithGrid("test_v1", fleet, 0.5);
    const second = generateWithGrid("test_v1", [...fleet].reverse(), 0.5);
    // Reversed input, identical output: the partition is a function of the
    // fleet, not of the order Postgres happened to return it in.
    expect(second).toEqual(first);
  });

  it("orders ids by represented MW, so a point's id says how big it is", () => {
    const set = generateWithGrid("test_v1", fleet, 0.5);
    const wind = set.centroids.filter((point) => point.technology === "WIND");
    expect(wind.map((point) => point.id)).toEqual(["W1", "W2"]);
    expect(wind[0]?.representedMw).toBeGreaterThan(wind[1]?.representedMw ?? 0);
    expect(set.centroids.filter((point) => point.technology === "SOLAR")[0]?.id).toBe(
      "S1",
    );
  });
});

describe("centroid generator · the MW floor", () => {
  const fleet: GeneratorPlant[] = [
    plant("BIG", { capacityMw: 2000 }),
    plant("SMALL", {
      capacityMw: 50,
      municipality: { name: "Touros", uf: "RN" },
      // 150 km away: its own cluster, and far below the floor.
      coordinate: { latitude: -6.3, longitude: -37 },
    }),
  ];

  it("drops a cluster below the floor and says so", () => {
    const set = generateWithGrid("test_v1", fleet, 0.5);
    expect(set.centroids).toHaveLength(1);
    expect(set.discarded).toEqual([
      expect.objectContaining({ reason: "below_mw_floor", representedMw: 50 }),
    ]);
  });

  it("keeps the dropped cluster's megawatts in the weight vector", () => {
    const set = generateWithGrid("test_v1", fleet, 0.5);
    const [vector] = computeCapacityWeights({
      plants: fleet,
      centroids: set.centroids,
    });
    // No point of its own, but not lost: the small plant weights the point it
    // is nearest to, and the vector still accounts for every megawatt.
    expect(vector?.capacityMw).toBe(2050);
    expect(vector?.cells.reduce((sum, cell) => sum + cell.weight, 0)).toBeCloseTo(1, 12);
    expect(vector?.attribution.placedMw).toBe(2050);
  });
});

describe("centroid generator · grid-cell collisions", () => {
  /** Two same-technology clusters 100 km apart — one 0.5° cell holds both. */
  const colliding: GeneratorPlant[] = [
    plant("A", {
      capacityMw: 1000,
      coordinate: { latitude: -5.05, longitude: -37.05 },
    }),
    plant("B", {
      capacityMw: 600,
      municipality: { name: "Serra do Mel", uf: "RN" },
      coordinate: { latitude: -5.15, longitude: -37.15 },
    }),
  ];

  it("merges two points in one cell and sums their megawatts", () => {
    // 80 km linkage would have clustered them anyway; the radius is dropped so
    // that the *collision* path is what merges them.
    const set = generateWithGrid("test_v1", colliding, 0.5, { clusterRadiusKm: 5 });
    expect(set.centroids).toHaveLength(1);
    expect(set.centroids[0]?.representedMw).toBe(1600);
    expect(set.merges).toEqual([
      expect.objectContaining({ reason: "grid_cell", merged: "RN|Serra do Mel" }),
    ]);
    expect(set.centroids[0]?.mergedFrom).toEqual(["RN|Serra do Mel"]);
    expect(set.collisionCheck).toBe("asserted");
  });

  it("drops the smaller side of a cross-technology collision, losing no MW", () => {
    const fleet: GeneratorPlant[] = [
      ...colliding.map((row) => ({ ...row, capacityMw: 1000 })),
      plant("SOL", {
        capacityMw: 600,
        technology: "SOLAR",
        subsystem: "NE",
        municipality: { name: "Açu", uf: "RN" },
        coordinate: { latitude: -5.1, longitude: -37.1 },
      }),
      plant("SOL2", {
        capacityMw: 900,
        technology: "SOLAR",
        subsystem: "NE",
        municipality: { name: "Petrolina", uf: "PE" },
        coordinate: { latitude: -9.4, longitude: -40.5 },
      }),
    ];
    const set = generateWithGrid("test_v1", fleet, 0.5, { clusterRadiusKm: 5 });
    // The wind cluster is larger, so the solar point yields its place. It cannot
    // be merged — a centroid carries one technology — and it is not nudged,
    // which would invent geography.
    expect(set.discarded).toEqual([
      expect.objectContaining({
        key: "RN|Açu",
        reason: "cross_technology_collision",
      }),
    ]);
    const solar = computeCapacityWeights({
      plants: fleet,
      centroids: set.centroids,
    }).find((vector) => vector.technology === "SOLAR");
    // 600 MW with no point of its own still weights the nearest solar centroid.
    expect(solar?.capacityMw).toBe(1500);
    expect(solar?.attribution.placedMw).toBe(1500);
  });

  it("refuses to call a set checked when a point's cell is unknown", () => {
    const set = generateCentroidSet("test_v1", colliding);
    expect(set.collisionCheck).toBe("unchecked");
    expect(set.pendingProbe).toHaveLength(set.centroids.length);
  });

  it("throws when two points survive with the same cell", () => {
    const twins: GeneratedCentroid[] = [
      {
        id: "W1",
        label: "one",
        latitude: -5,
        longitude: -37,
        technology: "WIND",
        representedMw: 100,
        provisional: false,
        municipalities: [],
        plants: 1,
        mergedFrom: [],
        gridCell: { latitude: -5, longitude: -37 },
      },
      {
        id: "S1",
        label: "two",
        latitude: -5.01,
        longitude: -37.01,
        technology: "SOLAR",
        representedMw: 100,
        provisional: false,
        municipalities: [],
        plants: 1,
        mergedFrom: [],
        gridCell: { latitude: -5, longitude: -37 },
      },
    ];
    expect(() => assertGeneratedCellsUnique(twins)).toThrow(GridCellCollisionError);
  });
});

describe("centroid generator · against the frozen nineteen", () => {
  /**
   * A fleet built *at* `centroid_set_v1`: one municipality per frozen point,
   * carrying the MW that point records as represented.
   *
   * This is the closest an offline test can get to "does the generator
   * reproduce the transcribed set". It cannot re-derive v1 from the real
   * registry — v1's clusters are hand-grouped municipalities and two of its
   * points were never computed from SIGA at all — but it can show that the
   * pipeline is a faithful inverse: given the fleet those nineteen points
   * describe, it returns those nineteen points.
   */
  const asFleet = (): GeneratorPlant[] =>
    CENTROIDS.map((centroid, index) => ({
      cegCore: `CEG.${index}`,
      subsystem: "NE" as const,
      technology: centroid.technology,
      capacityMw: centroid.representedMw,
      coordinate: { latitude: centroid.latitude, longitude: centroid.longitude },
      locationSource: "siga_coordinate" as const,
      municipality: { name: centroid.id, uf: "BR" },
    }));

  it("returns nineteen points, on the frozen coordinates", () => {
    const set = generateWithGrid("test_v1", asFleet(), 0.01);
    expect(set.centroids).toHaveLength(19);
    for (const centroid of CENTROIDS) {
      const generated = set.centroids.find(
        (point) => point.municipalities[0] === `${centroid.id}, BR`,
      );
      expect(generated).toBeDefined();
      expect(haversineKm(generated as GeneratedCentroid, centroid)).toBeLessThan(1e-6);
      expect(generated?.technology).toBe(centroid.technology);
      expect(generated?.representedMw).toBe(centroid.representedMw);
    }
  });

  it("keeps every v1 cluster distinct at the default linkage radius", () => {
    // The binding pair is W1/W2 at 103.5 km, so 75 km separates them with
    // ~28 km to spare. This is the measurement the default is chosen against.
    let closest = Number.POSITIVE_INFINITY;
    for (const a of CENTROIDS) {
      for (const b of CENTROIDS) {
        if (a.id >= b.id || a.technology !== b.technology) {
          continue;
        }
        closest = Math.min(closest, haversineKm(a, b));
      }
    }
    expect(closest).toBeCloseTo(103.5, 1);
    expect(DEFAULT_CLUSTER_RADIUS_KM).toBeLessThan(closest);
    // And the floor admits W12, the smallest cluster the research kept.
    expect(DEFAULT_MIN_CLUSTER_MW).toBeLessThan(426);
  });
});

describe("centroid generator · the freeze-time drift metric", () => {
  it("is zero when every plant sits on its centroid", () => {
    const fleet: GeneratorPlant[] = [plant("A", { capacityMw: 500 })];
    const set = generateWithGrid("test_v1", fleet, 0.5);
    const distance = measureCentroidDistance(fleet, set.centroids);
    expect(distance.meanDistanceKm).toBeCloseTo(0, 9);
    expect(distance.locatedMw).toBe(500);
  });

  it("weights the mean by capacity, not by plant count", () => {
    const fleet: GeneratorPlant[] = [
      plant("BIG", { capacityMw: 900 }),
      // 100 km from the big plant, and 1/9 of its megawatts.
      plant("FAR", {
        capacityMw: 100,
        municipality: { name: "Touros", uf: "RN" },
        coordinate: { latitude: -5.9, longitude: -37 },
      }),
    ];
    const set = generateWithGrid("test_v1", fleet, 0.5, { minClusterMw: 800 });
    // One kept point (the 900 MW cluster); the far plant weights it from 100 km
    // away, so the capacity-weighted mean is a tenth of that distance.
    expect(set.centroids).toHaveLength(1);
    const distance = measureCentroidDistance(fleet, set.centroids);
    const far = haversineKm(
      { latitude: -5.9, longitude: -37 },
      set.centroids[0] as GeneratedCentroid,
    );
    expect(distance.meanDistanceKm).toBeCloseTo((far * 100) / 1000, 6);
  });

  it("is null when nothing could be placed", () => {
    const unlocated: GeneratorPlant[] = [
      plant("A", { coordinate: null, locationSource: "unlocated" }),
    ];
    expect(measureCentroidDistance(unlocated, CENTROIDS).meanDistanceKm).toBeNull();
  });
});
