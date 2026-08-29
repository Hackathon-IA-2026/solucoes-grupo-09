import { describe, expect, it } from "bun:test";
import {
  aggregateSubsystemHour,
  type CapacityWeightSet,
  computeCapacityWeights,
  gridCellKey,
  haversineKm,
  readSubsystemWeatherAsOf,
  type WeatherPoint,
  type WeightablePlant,
  weightMisallocation,
} from "../src/features/index.js";
import type { Centroid } from "../src/ingest/weather/centroids.js";
import { CENTROIDS } from "../src/ingest/weather/centroids.js";

// Seam 3 for the aggregation half: the arithmetic is checked against a hand-built
// fleet with known answers, because every failure mode here is silent. A weight
// vector that sums to 0.97 still produces plausible weather; a wind variable
// weighted by the solar vector still produces plausible weather; averaging 350°
// and 10° as numbers produces plausible weather pointing the wrong way.

/** Four points wide apart, so nearest-centroid assignment has one obvious answer. */
const centroid = (
  id: string,
  latitude: number,
  longitude: number,
  technology: "WIND" | "SOLAR",
): Centroid => ({
  id,
  label: id,
  latitude,
  longitude,
  technology,
  representedMw: 0,
  provisional: false,
});

const TEST_CENTROIDS: Centroid[] = [
  centroid("W_N", -5, -37, "WIND"),
  centroid("W_S", -12, -41, "WIND"),
  centroid("S_N", -6, -38, "SOLAR"),
  centroid("S_S", -16, -44, "SOLAR"),
];

const plant = (
  cegCore: string,
  overrides: Partial<WeightablePlant> = {},
): WeightablePlant => ({
  cegCore,
  subsystem: "NE",
  technology: "WIND",
  capacityMw: 100,
  coordinate: { latitude: -5, longitude: -37 },
  locationSource: "siga_coordinate",
  ...overrides,
});

const vectorOf = (
  vectors: ReturnType<typeof computeCapacityWeights>,
  subsystem: "N" | "NE" | "S" | "SE",
  technology: "WIND" | "SOLAR",
) => {
  const found = vectors.find(
    (v) => v.subsystem === subsystem && v.technology === technology,
  );
  if (!found) {
    throw new Error(`no ${subsystem}/${technology} vector`);
  }
  return found;
};

const weightOf = (vector: ReturnType<typeof vectorOf>, centroidId: string): number =>
  vector.cells.find((cell) => cell.centroidId === centroidId)?.weight ?? 0;

describe("haversine", () => {
  it("reproduces the SE-solar centroid displacement the research measured", () => {
    // `docs/research/plant-registry.md` §5: the SE solar capacity centroid moves
    // from (−17.327, −45.758) at 2024-04 to (−16.489, −45.633) at 2026-08, and
    // the research calls that 94 km. This is the distance function agreeing.
    const km = haversineKm(
      { latitude: -17.327, longitude: -45.758 },
      { latitude: -16.489, longitude: -45.633 },
    );
    expect(km).toBeGreaterThan(90);
    expect(km).toBeLessThan(98);
  });

  it("is zero for a point against itself", () => {
    expect(
      haversineKm({ latitude: -5, longitude: -37 }, { latitude: -5, longitude: -37 }),
    ).toBe(0);
  });
});

describe("capacity weights", () => {
  it("assigns each plant to the nearest centroid of its own technology", () => {
    const vectors = computeCapacityWeights({
      centroids: TEST_CENTROIDS,
      plants: [
        plant("w-north", { coordinate: { latitude: -5.2, longitude: -37.1 } }),
        plant("w-south", { coordinate: { latitude: -12.1, longitude: -41.2 } }),
      ],
    });
    const wind = vectorOf(vectors, "NE", "WIND");
    expect(weightOf(wind, "W_N")).toBeCloseTo(0.5, 12);
    expect(weightOf(wind, "W_S")).toBeCloseTo(0.5, 12);
    // A wind plant is never assigned to a solar point, however close it sits:
    // S_N is 111 km from the northern wind plant and W_N is 22 km away.
    expect(weightOf(wind, "S_N")).toBe(0);
  });

  it("gives wind and solar separate vectors that do not share weight", () => {
    const vectors = computeCapacityWeights({
      centroids: TEST_CENTROIDS,
      plants: [
        plant("wind", { capacityMw: 300 }),
        plant("solar", {
          technology: "SOLAR",
          capacityMw: 100,
          coordinate: { latitude: -16.1, longitude: -44.1 },
        }),
      ],
    });
    expect(vectors).toHaveLength(2);
    const wind = vectorOf(vectors, "NE", "WIND");
    const solar = vectorOf(vectors, "NE", "SOLAR");
    expect(wind.capacityMw).toBe(300);
    expect(solar.capacityMw).toBe(100);
    expect(weightOf(wind, "W_N")).toBeCloseTo(1, 12);
    expect(weightOf(solar, "S_S")).toBeCloseTo(1, 12);
    // The two vectors are over disjoint points: no wind weight anywhere near
    // the solar fleet, which is the whole reason they are two vectors.
    expect(wind.cells.map((cell) => cell.centroidId)).toEqual(["W_N"]);
    expect(solar.cells.map((cell) => cell.centroidId)).toEqual(["S_S"]);
  });

  it("weights sum to one within each vector", () => {
    const vectors = computeCapacityWeights({
      centroids: TEST_CENTROIDS,
      plants: [
        plant("a", { capacityMw: 700 }),
        plant("b", {
          capacityMw: 300,
          coordinate: { latitude: -12.5, longitude: -41.5 },
        }),
      ],
    });
    const wind = vectorOf(vectors, "NE", "WIND");
    expect(weightOf(wind, "W_N")).toBeCloseTo(0.7, 12);
    expect(weightOf(wind, "W_S")).toBeCloseTo(0.3, 12);
    const total = wind.cells.reduce((sum, cell) => sum + cell.weight, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it("places a municipality-centroid plant and records that it was a fallback", () => {
    const vectors = computeCapacityWeights({
      centroids: TEST_CENTROIDS,
      plants: [
        plant("own-coordinate", { capacityMw: 100 }),
        plant("null-island", {
          capacityMw: 50,
          // DP-05 rejected SIGA's (0,0) and put the plant at its municipality's
          // centroid. It has a usable point here, and is weighted like any other.
          locationSource: "siga_municipality_centroid",
          coordinate: { latitude: -12, longitude: -41 },
        }),
      ],
    });
    const wind = vectorOf(vectors, "NE", "WIND");
    expect(wind.attribution.sigaCoordinateMw).toBe(100);
    expect(wind.attribution.municipalityCentroidMw).toBe(50);
    expect(wind.attribution.proRataMw).toBe(0);
    expect(weightOf(wind, "W_S")).toBeCloseTo(50 / 150, 12);
  });

  it("still counts the capacity of a plant with no coordinate at all", () => {
    const located = computeCapacityWeights({
      centroids: TEST_CENTROIDS,
      plants: [
        plant("a", { capacityMw: 700 }),
        plant("b", {
          capacityMw: 300,
          coordinate: { latitude: -12.5, longitude: -41.5 },
        }),
      ],
    });
    const withUnlocated = computeCapacityWeights({
      centroids: TEST_CENTROIDS,
      plants: [
        plant("a", { capacityMw: 700 }),
        plant("b", {
          capacityMw: 300,
          coordinate: { latitude: -12.5, longitude: -41.5 },
        }),
        plant("no-point", {
          capacityMw: 250,
          coordinate: null,
          locationSource: "unlocated",
        }),
      ],
    });
    const before = vectorOf(located, "NE", "WIND");
    const after = vectorOf(withUnlocated, "NE", "WIND");

    // Its MW is in the scope total and in the placed mass — not dropped.
    expect(after.capacityMw).toBe(1250);
    expect(after.attribution.proRataMw).toBe(250);
    expect(after.attribution.unattributedMw).toBe(0);
    expect(after.attribution.placedMw).toBe(1250);
    expect(after.attribution.unlocatedPlants).toBe(1);
    // Pro rata leaves the *shape* of the vector alone, which is the point: the
    // plant contributes capacity without inventing a location for itself.
    expect(weightOf(after, "W_N")).toBeCloseTo(weightOf(before, "W_N"), 12);
    expect(weightOf(after, "W_S")).toBeCloseTo(weightOf(before, "W_S"), 12);
    expect(after.cells.reduce((sum, cell) => sum + cell.weight, 0)).toBeCloseTo(1, 12);
    // And the placed MW behind each share is scaled up by the spread.
    expect(after.cells.reduce((sum, cell) => sum + cell.capacityMw, 0)).toBeCloseTo(
      1250,
      9,
    );
  });

  it("reports unattributed MW rather than inventing a location for a scope with no point", () => {
    const vectors = computeCapacityWeights({
      centroids: TEST_CENTROIDS,
      plants: [
        plant("only-plant", {
          subsystem: "N",
          capacityMw: 426,
          coordinate: null,
          locationSource: "unlocated",
        }),
      ],
    });
    const wind = vectorOf(vectors, "N", "WIND");
    expect(wind.capacityMw).toBe(426);
    expect(wind.attribution.unattributedMw).toBe(426);
    expect(wind.attribution.proRataMw).toBe(0);
    expect(wind.cells).toEqual([]);
    expect(wind.meanDistanceKm).toBeNull();
    expect(wind.capacityCentroid).toBeNull();
  });

  it("merges two centroids that snapped to the same model grid cell", () => {
    // Open-Meteo echoes the cell it snapped a query to; two frozen points in one
    // cell would enter the weighted mean twice under two weights, which doubles
    // a region silently. Merging sums the weights instead.
    const cell = { latitude: -5.0, longitude: -37.0 };
    const vectors = computeCapacityWeights({
      centroids: [
        centroid("W_A", -5.0, -37.0, "WIND"),
        centroid("W_B", -5.02, -37.02, "WIND"),
        centroid("W_FAR", -12, -41, "WIND"),
      ],
      gridCells: new Map([
        ["W_A", cell],
        ["W_B", cell],
        ["W_FAR", { latitude: -12, longitude: -41 }],
      ]),
      plants: [
        plant("a", { capacityMw: 300, coordinate: { latitude: -5.0, longitude: -37.0 } }),
        plant("b", {
          capacityMw: 100,
          coordinate: { latitude: -5.02, longitude: -37.02 },
        }),
        plant("far", { capacityMw: 100, coordinate: { latitude: -12, longitude: -41 } }),
      ],
    });
    const wind = vectorOf(vectors, "NE", "WIND");
    expect(wind.cells).toHaveLength(2);
    const merged = wind.cells[0];
    expect(merged?.centroidId).toBe("W_A");
    expect(merged?.memberIds).toEqual(["W_A", "W_B"]);
    expect(merged?.capacityMw).toBe(400);
    expect(merged?.weight).toBeCloseTo(0.8, 12);
    expect(gridCellKey(cell)).toBe("-5.0000,-37.0000");
  });

  it("does not merge points whose cells were never echoed", () => {
    // Without a measured cell there is no evidence of a collision, and guessing
    // one from the frozen coordinates would merge points the model keeps apart.
    const vectors = computeCapacityWeights({
      centroids: [
        centroid("W_A", -5.0, -37.0, "WIND"),
        centroid("W_B", -5.02, -37.02, "WIND"),
      ],
      plants: [
        plant("a", { capacityMw: 300, coordinate: { latitude: -5.0, longitude: -37.0 } }),
        plant("b", {
          capacityMw: 100,
          coordinate: { latitude: -5.02, longitude: -37.02 },
        }),
      ],
    });
    expect(vectorOf(vectors, "NE", "WIND").cells).toHaveLength(2);
  });

  it("records the capacity-weighted mean distance and centroid", () => {
    const vectors = computeCapacityWeights({
      centroids: TEST_CENTROIDS,
      plants: [
        plant("on-point", { capacityMw: 900 }),
        plant("off-point", {
          capacityMw: 100,
          coordinate: { latitude: -6, longitude: -37 },
        }),
      ],
    });
    const wind = vectorOf(vectors, "NE", "WIND");
    // 900 MW at zero distance, 100 MW one degree of latitude (≈111 km) away.
    expect(wind.meanDistanceKm).toBeCloseTo(11.1, 0);
    expect(wind.capacityCentroid?.latitude).toBeCloseTo(-5.1, 12);
    expect(wind.capacityCentroid?.longitude).toBeCloseTo(-37, 12);
  });

  it("assigns the real frozen set by technology", () => {
    // Against `centroid_set_v1` itself: a Janaúba MG solar plant belongs to S5,
    // and a João Câmara RN wind plant to W7 — not to whichever point is nearest
    // overall.
    const vectors = computeCapacityWeights({
      centroids: CENTROIDS,
      plants: [
        plant("janauba", {
          subsystem: "SE",
          technology: "SOLAR",
          coordinate: { latitude: -15.8, longitude: -43.3 },
        }),
        plant("joao-camara", {
          coordinate: { latitude: -5.53, longitude: -35.82 },
        }),
      ],
    });
    expect(vectorOf(vectors, "SE", "SOLAR").cells[0]?.centroidId).toBe("S5");
    expect(vectorOf(vectors, "NE", "WIND").cells[0]?.centroidId).toBe("W7");
  });
});

describe("weight misallocation", () => {
  it("is the share of weight mass two vectors place differently", () => {
    const a = [
      { centroidId: "X", memberIds: ["X"], cell: null, weight: 1, capacityMw: 100 },
      { centroidId: "Y", memberIds: ["Y"], cell: null, weight: 0, capacityMw: 0 },
    ];
    const b = [
      { centroidId: "X", memberIds: ["X"], cell: null, weight: 0.5, capacityMw: 50 },
      { centroidId: "Y", memberIds: ["Y"], cell: null, weight: 0.5, capacityMw: 50 },
    ];
    expect(weightMisallocation(a, a)).toBe(0);
    expect(weightMisallocation(a, b)).toBeCloseTo(0.5, 12);
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const point = (
  centroidId: string,
  overrides: Partial<WeatherPoint> = {},
): WeatherPoint => ({
  centroidId,
  validTime: new Date("2026-08-28T12:00:00.000Z"),
  runAgeHours: 0,
  windSpeed100mKmh: 10,
  windSpeed120mKmh: 20,
  windDirection120mDeg: 90,
  windGusts10mKmh: 30,
  temperature2mC: 25,
  surfacePressureHpa: 1010,
  relativeHumidity2mPct: 60,
  precipitationMm: 0,
  shortwaveRadiationWm2: 800,
  directNormalIrradianceWm2: 700,
  diffuseRadiationWm2: 100,
  cloudCoverPct: 10,
  ...overrides,
});

/** 300 MW of wind on W_N, 100 MW of solar on S_S. */
const weightSet = (plants: WeightablePlant[]): CapacityWeightSet => ({
  on: new Date("2026-08-28T00:00:00.000Z"),
  asOf: new Date("2026-08-28T09:00:00.000Z"),
  centroidSetVersion: "test",
  vectors: computeCapacityWeights({ centroids: TEST_CENTROIDS, plants }),
  vintageFidelity: "point_in_time",
});

const HOUR = new Date("2026-08-28T12:00:00.000Z");

describe("subsystem weather aggregation", () => {
  const weights = weightSet([
    plant("w1", { capacityMw: 300 }),
    plant("w2", {
      capacityMw: 100,
      coordinate: { latitude: -12, longitude: -41 },
    }),
    plant("s1", {
      technology: "SOLAR",
      capacityMw: 100,
      coordinate: { latitude: -16, longitude: -44 },
    }),
  ]);

  it("weights wind variables by the wind vector alone", () => {
    const row = aggregateSubsystemHour(
      "NE",
      HOUR,
      [
        point("W_N", { windSpeed120mKmh: 40 }),
        point("W_S", { windSpeed120mKmh: 0 }),
        // The solar point is loud and must not move a wind variable at all.
        point("S_S", { windSpeed120mKmh: 1000 }),
      ],
      weights,
    );
    // 0.75 × 40 + 0.25 × 0.
    expect(row.windSpeed120mKmh).toBeCloseTo(30, 12);
  });

  it("weights solar variables by the solar vector alone", () => {
    const row = aggregateSubsystemHour(
      "NE",
      HOUR,
      [
        point("W_N", { shortwaveRadiationWm2: 0 }),
        point("S_S", { shortwaveRadiationWm2: 950 }),
      ],
      weights,
    );
    expect(row.shortwaveRadiationWm2).toBeCloseTo(950, 12);
  });

  it("weights the shared variables by combined VRE capacity", () => {
    // 400 MW wind (0.75 on W_N, 0.25 on W_S) against 100 MW solar on S_S, so
    // the VRE weights are 0.6 / 0.2 / 0.2.
    const row = aggregateSubsystemHour(
      "NE",
      HOUR,
      [
        point("W_N", { temperature2mC: 30 }),
        point("W_S", { temperature2mC: 20 }),
        point("S_S", { temperature2mC: 10 }),
      ],
      weights,
    );
    expect(row.temperature2mC).toBeCloseTo(0.6 * 30 + 0.2 * 20 + 0.2 * 10, 12);
  });

  it("averages wind direction as a vector, not as a number", () => {
    const row = aggregateSubsystemHour(
      "NE",
      HOUR,
      [
        point("W_N", { windDirection120mDeg: 350 }),
        point("W_S", { windDirection120mDeg: 10 }),
      ],
      weightSet([
        plant("a", { capacityMw: 100 }),
        plant("b", {
          capacityMw: 100,
          coordinate: { latitude: -12, longitude: -41 },
        }),
      ]),
    );
    // Due north, not the 180° a numeric mean would give.
    const degrees =
      (Math.atan2(row.windDirection120mSin ?? 0, row.windDirection120mCos ?? 0) * 180) /
        Math.PI +
      360;
    expect(degrees % 360).toBeCloseTo(0, 9);
    expect(
      Math.hypot(row.windDirection120mSin ?? 0, row.windDirection120mCos ?? 0),
    ).toBeCloseTo(1, 12);
  });

  it("renormalises over the centroids that reported, and says how much was missing", () => {
    const row = aggregateSubsystemHour(
      "NE",
      HOUR,
      [point("W_N", { windSpeed120mKmh: 40 })],
      weights,
    );
    // W_S is absent. The mean is W_N's own value rather than 0.75 × 40 = 30,
    // which would be a hole rendered as calm weather.
    expect(row.windSpeed120mKmh).toBeCloseTo(40, 12);
    // Coverage is weighted: W_N carries 0.6 of NE's combined VRE mass.
    expect(row.centroidCoverage).toBeCloseTo(0.6, 12);
  });

  it("returns null rather than a number when nothing reported", () => {
    const row = aggregateSubsystemHour("NE", HOUR, [], weights);
    expect(row.windSpeed120mKmh).toBeNull();
    expect(row.shortwaveRadiationWm2).toBeNull();
    expect(row.windDirection120mSin).toBeNull();
    expect(row.centroidCoverage).toBe(0);
    expect(row.runAgeHours).toBeNull();
  });

  it("carries the oldest contributing run age, not the mean", () => {
    const row = aggregateSubsystemHour(
      "NE",
      HOUR,
      [point("W_N", { runAgeHours: 0 }), point("W_S", { runAgeHours: 12 })],
      weights,
    );
    expect(row.runAgeHours).toBe(12);
  });

  it("ignores a centroid that carries no weight in this subsystem", () => {
    const row = aggregateSubsystemHour(
      "S",
      HOUR,
      [point("W_N", { runAgeHours: 24 })],
      weights,
    );
    // The whole fleet above is NE, so S has no vector and nothing to aggregate.
    expect(row.centroidCoverage).toBe(0);
    expect(row.runAgeHours).toBeNull();
  });

  it("exports the composed read", () => {
    expect(typeof readSubsystemWeatherAsOf).toBe("function");
  });
});
