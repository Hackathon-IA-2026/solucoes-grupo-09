/**
 * The WattSteer project, as one definition.
 *
 * This replaces `railway.json` and `apps/ml/railway.json`, which Railway stops
 * reading on **2026-12-01**. It was produced by `railway config pull` — which
 * imports *live* state, and is the only route that starts from everything:
 * the IaC contract is "one project definition, one apply, omit means delete",
 * so a file hand-authored from the two Config-as-Code files would have declared
 * two services and omitted Postgres, Redis, three volumes and the bucket, and
 * an apply would then have destroyed them.
 *
 * **Two fields the pull did not carry, and both were verified against the live
 * service records rather than assumed:**
 *
 * 1. `ml`'s `source.rootDirectory` (`apps/ml`). `get-service-config` reports it
 *    live; the importer omits it. The ML image's build context *is* `apps/ml`
 *    — its Dockerfile copies `pyproject.toml` and `uv.lock` from the context
 *    root — so applying the imported file unedited would have unset it and
 *    broken the build with `couldn't locate the dockerfile at path Dockerfile`.
 *    That failure is not hypothetical: it is what this service did on its first
 *    deploy, before the root directory was set.
 *
 * 2. `restartPolicyType: "ON_FAILURE"` on the three Dockerfile services. Only
 *    `restartPolicyMaxRetries` survived the import, and a max-retries without a
 *    policy is the platform default (`ALWAYS`) wearing a retry count. Note that
 *    the live service records do not carry the policy *either*: it has been
 *    coming from `railway.json` at deploy time all along. So this line is not a
 *    copy of live state — it is the setting that silently reverts to `ALWAYS`
 *    the moment Config as Code stops being read, written down before it can.
 *
 * `preserve()` keeps each variable's value on Railway rather than in git. The
 * generated `*.up.railway.app` domains are deliberately absent: IaC does not
 * manage them, and naming them here would not make them managed.
 */
import {
  bucket,
  defineRailway,
  postgres,
  preserve,
  project,
  redis,
  service,
  volume,
} from "railway/iac";

/**
 * Every Dockerfile-built service restarts on failure, five times.
 *
 * One object because the three services genuinely share one policy, and
 * because the pair has to move together: `restartPolicyMaxRetries` alone is
 * what the importer produced, and it means something different.
 */
const RESTART_ON_FAILURE = {
  restartPolicyType: "ON_FAILURE",
  restartPolicyMaxRetries: 5,
} as const;

/** The one region this project runs in. */
const REGION = "us-east4-eqdc4a";

/** Volume defaults, identical across all three — 50 GB with usage alerts. */
const VOLUME = {
  alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  allowOnlineResize: true,
  region: REGION,
  sizeMB: 50_000,
} as const;

export default defineRailway(() => {
  const Redis = redis("Redis", { region: REGION });
  // Pinned to what is *running*, not to what the helper defaults to. A bare
  // `redis("Redis")` plans `redis:8` and `postgres("Postgres")` plans
  // `postgres:18`; live these are `redis:7-alpine` and
  // `ghcr.io/railwayapp-templates/postgres-ssl:16`. Applying the imported file
  // unedited would have major-version-upgraded both live data stores as a side
  // effect of a config migration.
  Redis.source = { type: "image", image: "redis:7-alpine" };
  Redis.deploy = {
    restartPolicyType: "ALWAYS",
    // Wrapped in `sh -c` deliberately: Railway's V2 runtime execs the start
    // command without a shell, so a bare `$REDIS_PASSWORD` reached
    // `--requirepass` as a literal and every real password was refused with
    // WRONGPASS.
    startCommand:
      "sh -c 'exec redis-server --requirepass \"$REDIS_PASSWORD\" --appendonly yes --dir /data'",
  };
  Redis.networking = { privateNetworkEndpoint: "redis" };

  const Postgres = postgres("Postgres", { region: REGION });
  Postgres.source = {
    type: "image",
    image: "ghcr.io/railwayapp-templates/postgres-ssl:16",
  };
  Postgres.deploy = { restartPolicyType: "ON_FAILURE" };
  Postgres.networking = { privateNetworkEndpoint: "postgres" };

  const postgresData = volume("postgres-data", VOLUME);
  const redisData = volume("redis-data", VOLUME);
  const mlModels = volume("ml-models", VOLUME);
  const wattsteerArchive = bucket("wattsteer-archive", { region: "iad" });

  const api = service("api", {
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "apps/api/Dockerfile",
    },
    healthcheck: "/health",
    healthcheckTimeout: 120,
    replicas: { [REGION]: 1 },
    deploy: { ...RESTART_ON_FAILURE },
    env: {
      DATABASE_URL: preserve(),
      NODE_ENV: preserve(),
      PORT: preserve(),
      REDIS_URL: preserve(),
      WATTSTEER_ARCHIVE_ACCESS_KEY_ID: preserve(),
      WATTSTEER_ARCHIVE_BUCKET: preserve(),
      WATTSTEER_ARCHIVE_ENDPOINT: preserve(),
      WATTSTEER_ARCHIVE_REGION: preserve(),
      WATTSTEER_ARCHIVE_SECRET_ACCESS_KEY: preserve(),
      WATTSTEER_DASHBOARD: preserve(),
      WATTSTEER_ML_URL: preserve(),
      WATTSTEER_RATE_LIMIT: preserve(),
      WATTSTEER_RATE_WINDOW_MS: preserve(),
      WATTSTEER_ROLE: preserve(),
    },
  });

  // Same image as the api, different entrypoint and role. No healthcheck: it
  // serves no HTTP, and the root `railway.json` offering it one was a setting
  // that never applied to anything.
  const worker = service("worker", {
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "apps/api/Dockerfile",
    },
    start: "bun run src/worker.ts",
    replicas: { [REGION]: 1 },
    deploy: { ...RESTART_ON_FAILURE },
    env: {
      DATABASE_URL: preserve(),
      NODE_ENV: preserve(),
      REDIS_URL: preserve(),
      WATTSTEER_ARCHIVE_ACCESS_KEY_ID: preserve(),
      WATTSTEER_ARCHIVE_BUCKET: preserve(),
      WATTSTEER_ARCHIVE_ENDPOINT: preserve(),
      WATTSTEER_ARCHIVE_REGION: preserve(),
      WATTSTEER_ARCHIVE_RETENTION_DAYS: preserve(),
      WATTSTEER_ARCHIVE_SECRET_ACCESS_KEY: preserve(),
      WATTSTEER_JOB_CONCURRENCY: preserve(),
      WATTSTEER_ML_URL: preserve(),
      WATTSTEER_ROLE: preserve(),
    },
  });

  const ml = service("ml", {
    // The build context is `apps/ml`, not the repository root: this service
    // shares no lockfile with the Bun workspace. `dockerfilePath` is therefore
    // relative to that directory, and dropping either one breaks the build.
    source: { type: "github", rootDirectory: "apps/ml" },
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    start: "wattsteer-ml",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    replicas: { [REGION]: 1 },
    deploy: { ...RESTART_ON_FAILURE },
    // Mounted at the artifact directory itself, not at `/data`. A volume
    // mounted one level up masks the image's `mkdir -p /data/models`, and
    // `artifacts.py` reads a missing directory as "the volume did not mount" —
    // which is exactly what `/v1/meta` reported before this was corrected.
    volumeMounts: { "/data/models": mlModels },
    env: {
      DATABASE_URL: preserve(),
      PORT: preserve(),
      // Start the container as root so the entrypoint can chown the
      // root-owned volume; it drops to `wattsteer` via setpriv before exec'ing
      // the service, so the Python process is not root.
      RAILWAY_RUN_UID: preserve(),
      WATTSTEER_ML_ARTIFACT_DIR: preserve(),
      WATTSTEER_ML_ENV: preserve(),
    },
  });

  // Built from a Dockerfile too, but through `RAILWAY_DOCKERFILE_PATH` rather
  // than the builder field — which is why its builder reads `RAILPACK`.
  const web = service("web", {
    replicas: { [REGION]: 1 },
    env: {
      EXPO_PUBLIC_API_URL: preserve(),
      EXPO_PUBLIC_SITE_URL: preserve(),
      PORT: preserve(),
      RAILWAY_DOCKERFILE_PATH: preserve(),
    },
  });

  return project("wattsteer", {
    resources: [
      Postgres,
      Redis,
      api,
      worker,
      ml,
      web,
      postgresData,
      redisData,
      mlModels,
      wattsteerArchive,
    ],
  });
});
