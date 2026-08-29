import { config } from "../config.js";
import { createDatabase } from "../database/connection.js";
import {
  DEFAULT_CLUSTER_RADIUS_KM,
  DEFAULT_MIN_CLUSTER_MW,
} from "../ingest/weather/centroid-generator.js";
import { type GridProbe, regenerateCentroids } from "../ingest/weather/centroid-job.js";
import { CENTROID_SET_VERSION } from "../ingest/weather/centroids.js";
import {
  fetchModelRun,
  previousRun,
  scheduledRunFor,
} from "../ingest/weather/single-runs.js";

/**
 * Cut a centroid set from the registry.
 *
 *     bun run src/scripts/generate-centroids.ts --version centroid_set_v2
 *     bun run src/scripts/generate-centroids.ts --version centroid_set_v2 --dry-run
 *
 * **This is the script the ticket asks for** — the points come out of the plant
 * registry and SIGA rather than out of a person's transcription, and running it
 * twice on the same registry vintage produces the same set, which is what makes
 * a regeneration a reviewable diff.
 *
 * It will not touch `centroid_set_v1`. The active set is the geometry weather
 * has already been ingested at; a regeneration is a **new version, a new
 * feature-set version and a retrain**, and promoting one is a deliberate change
 * to `CENTROID_SET_VERSION`, not something a script does on its way past.
 *
 * The grid probe is real: one Single Runs call at a recent run, one variable,
 * one forecast day, purely to read back the cells Open-Meteo snaps the
 * candidate points to. Without it a set cannot be frozen, because grid-cell
 * uniqueness would be an assertion nobody checked.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const version = flag("version");
if (!version) {
  console.error(
    "usage: generate-centroids.ts --version <centroid_set_vN> [--dry-run] " +
      "[--radius-km N] [--min-mw N]",
  );
  process.exit(1);
}
if (version === CENTROID_SET_VERSION) {
  console.error(
    `${CENTROID_SET_VERSION} is the set in use and is frozen. Cut a new version.`,
  );
  process.exit(1);
}
if (!config.databaseUrl) {
  console.error("DATABASE_URL is required — the registry is what the set is cut from");
  process.exit(1);
}

const database = createDatabase(config.databaseUrl);

/** The most recent run whose archive is reliably present: yesterday's 00Z. */
const runInit = previousRun(
  scheduledRunFor(new Date().toISOString().slice(0, 10), "00Z"),
);

const probe: GridProbe = async (points) => {
  const response = await fetchModelRun({
    runInit,
    points: points.map((point, index) => ({
      id: `probe-${index}`,
      latitude: point.latitude,
      longitude: point.longitude,
    })),
    // One variable and one day: this call is asked only for the `latitude` and
    // `longitude` it echoes back, which is the grid cell each point snapped to.
    variables: ["wind_speed_100m"],
    forecastDays: 1,
  });
  return response.locations.map((location) => ({
    latitude: location.latitude,
    longitude: location.longitude,
  }));
};

const result = await regenerateCentroids(database.db, {
  version,
  probe,
  dryRun: has("dry-run"),
  options: {
    clusterRadiusKm: Number(flag("radius-km") ?? DEFAULT_CLUSTER_RADIUS_KM),
    minClusterMw: Number(flag("min-mw") ?? DEFAULT_MIN_CLUSTER_MW),
  },
});

const { set, distance, baselineDistance } = result;
console.log(
  `${set.version}: ${set.centroids.length} points, ` +
    `${set.representedMw.toFixed(0)} MW of ${set.locatedMw.toFixed(0)} located MW, ` +
    `${set.plants} plants (${set.unlocatedPlants} unlocated), ` +
    `${result.probeRounds} probe round(s), collisions ${set.collisionCheck}`,
);
for (const centroid of set.centroids) {
  console.log(
    `  ${centroid.id.padEnd(4)} ${centroid.latitude.toFixed(3)} ` +
      `${centroid.longitude.toFixed(3)}  ${centroid.representedMw.toFixed(0).padStart(6)} MW  ` +
      `${centroid.label}`,
  );
}
for (const merge of set.merges) {
  console.log(
    `  merged ${merge.merged} into ${merge.kept} (${merge.reason}, ${merge.cell})`,
  );
}
for (const dropped of set.discarded) {
  console.log(
    `  discarded ${dropped.key} (${dropped.reason}, ${dropped.representedMw.toFixed(0)} MW) ` +
      "— its plants weight the nearest kept centroid",
  );
}
console.log(
  `  drift baseline: ${distance.meanDistanceKm?.toFixed(1) ?? "n/a"} km ` +
    `(${CENTROID_SET_VERSION} over the same fleet: ` +
    `${baselineDistance.meanDistanceKm?.toFixed(1) ?? "n/a"} km)`,
);
console.log(
  result.dryRun
    ? "  dry run — nothing written"
    : result.frozen
      ? `  frozen as ${set.version}. Promoting it is a new feature-set version and a retrain.`
      : `  ${set.version} was already frozen with identical geometry — nothing written.`,
);

await database.close();
