import { createHash } from "node:crypto";
import { cors } from "@elysiajs/cors";
import { serverTiming } from "@elysiajs/server-timing";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { config } from "../config.js";
import { database } from "../database/connection.js";
import { loggableError } from "../errors.js";
import { canonicalReads } from "./canonical.js";
import { curtailmentRoutes } from "./curtailment.js";
import { diagnosisRoutes } from "./diagnosis.js";
import { forecastRoutes } from "./forecast.js";
import { gridRoutes } from "./grid.js";
import { ingestHealth } from "./ingest-health.js";
import { metaRoutes } from "./meta.js";
import { modelCardRoutes } from "./model-card.js";
import { optimizeCache, optimizeRoutes } from "./optimize.js";
import { plantRoutes } from "./plants.js";
import {
  bodyLimit,
  MAX_BODY_BYTES,
  SOLVE_MAX_BODY_BYTES,
  solveBodyLimit,
} from "./plugins/body-limit.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";
import { errorHandler } from "./plugins/errors.js";
import { limitStore } from "./plugins/limit-store-handle.js";
import { rateLimit, tiersFrom } from "./plugins/rate-limit.js";
import { requestContext } from "./plugins/request-context.js";
import { securityHeaders } from "./plugins/security.js";
import { replayRoutes } from "./replay.js";
import { voiceRoutes } from "./voice.js";

const isProd = config.isProd;

/**
 * Where the budgets are counted: Redis when one is configured, so two API
 * replicas share one budget, and the per-process map otherwise. The boot log
 * says which, because "the published budget is the real budget" is not
 * something an operator should have to infer.
 *
 * Held in `./plugins/limit-store-handle.ts` and re-exported here: the narration
 * route spends the daily cap against the same counter, and it cannot import the
 * module that mounts it.
 */
export { limitStore } from "./plugins/limit-store-handle.js";

/**
 * The service banner — a constant of the deployment, built once.
 *
 * Once rather than per request because it cannot differ per request, which is
 * what lets the validator below be a fact about the build.
 */
const BANNER = { name: "wattsteer", version: "0.1.0", docs: "/docs" };

/**
 * The banner's validator: a digest of the bytes this process will serve.
 *
 * `canonical.ts`'s `MANIFEST_VERSION`, for the same reason and by the same
 * construction — a banner has no `published_at` and no `data_version`, so a
 * content provenance is the only kind available, and computing it at module
 * load is what keeps it a fact about the build rather than about the request.
 * A deploy that changes the name, the version or the docs path moves it; the
 * rule this repo enforces is that nothing else may.
 */
const BANNER_VERSION = createHash("sha256")
  .update(JSON.stringify(BANNER))
  .digest("hex")
  .slice(0, 16);

/**
 * Readiness: when a database is configured it must answer before we accept
 * traffic. With no database configured there is nothing to warm up.
 */
async function ready(): Promise<boolean> {
  if (!database) {
    return true;
  }
  return database.ping();
}

/**
 * The WattSteer HTTP API. Cross-cutting plugins (security headers, body limit,
 * CORS, server timing) are composed via `.use()`, with Swagger/OpenAPI docs at
 * `/docs`.
 *
 * The domain surface so far is the ingestion health view and the canonical read
 * contract (`/v1/canonical/*`) — the reads the modelling side consumes instead
 * of the fact tables. The product's own `/v1` routes arrive with the forecaster.
 */
export const app = new Elysia()
  .use(securityHeaders)
  .use(requestContext)
  .use(bodyLimit())
  // The solve routes' 16 KB ceiling, mounted centrally so it is in force from
  // the moment such a route exists rather than when someone remembers it.
  .use(solveBodyLimit())
  .use(
    rateLimit({
      tiers: tiersFrom({
        readMax: config.rateLimitMax,
        windowMs: config.rateLimitWindowMs,
        solveMax: config.rateLimitSolveMax,
        solveBurst: config.rateLimitSolveBurst,
        voiceMax: config.voiceSessionMax,
      }),
      store: limitStore,
      trustedProxyDepth: config.trustedProxyDepth,
    }),
  )
  .use(
    cors({
      // Dev: any origin (local Expo web runs on arbitrary ports). Prod: only
      // the origins listed in WATTSTEER_CORS_ORIGINS — the deployed web app's
      // origin must be there or its browser calls fail preflight.
      origin: isProd ? config.corsOrigins : true,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
      exposeHeaders: ["Content-Type", "Server-Timing"],
    }),
  )
  .use(serverTiming())
  .use(errorHandler)
  // `/docs` and `/docs/json` name their row here rather than in a handler,
  // because the Swagger plugin owns both routes and there is no handler of ours
  // to put it in. `onRequest` for the same reason `securityHeaders` uses it:
  // it runs before routing, so the directive is on the UI shell and on the
  // OpenAPI document alike, and `cspFor` already keys the same prefix.
  .onRequest(({ request, set }) => {
    if (new URL(request.url).pathname.startsWith("/docs")) {
      applyCachePolicy({ set, request }, CACHE_POLICIES.docs);
    }
  })
  .use(
    swagger({
      path: "/docs",
      documentation: {
        info: {
          title: "WattSteer API",
          version: "0.1.0",
          description:
            "Renewable curtailment intelligence for the Brazilian grid: " +
            "day-ahead forecasts, diagnosis, flexibility optimisation and historical replay.",
          contact: { name: "WattSteer" },
          license: { name: "MIT" },
        },
        // No hardcoded server: Swagger UI uses the origin it was loaded from, so
        // "Execute" hits the right host on localhost and in production alike.
        // Set WATTSTEER_PUBLIC_URL to pin it explicitly.
        ...(config.publicUrl
          ? { servers: [{ url: config.publicUrl, description: "Public" }] }
          : {}),
      },
    }),
  )
  // The unmetered tier's four routes, and four caching rows rather than one.
  // Being on a tier is a rate-limiting fact; it has never been a caching
  // argument, and `plugins/cache-policy.ts` states each of the four separately.
  .get(
    "/",
    ({ set, request }) => {
      // A build constant with a digest over the bytes it serves, so a reader
      // holding this deployment's banner gets a 304 rather than a copy of it.
      if (
        applyCachePolicy({ set, request }, CACHE_POLICIES.serviceBanner, [BANNER_VERSION])
      ) {
        return null;
      }
      return BANNER;
    },
    { detail: { summary: "API info" } },
  )
  .get(
    "/health",
    ({ set, request }) => {
      // `no-store`, and the constant body is the reason rather than an excuse:
      // the only thing this response carries is that *this* process answered.
      applyCachePolicy({ set, request }, CACHE_POLICIES.liveness);
      return { status: "ok" as const };
    },
    { detail: { summary: "Liveness" } },
  )
  .get(
    "/ready",
    async ({ set, request }) => {
      // Before the branch, so the 200 and the 503 both carry it. `/ready`'s
      // 503 is set here on its own body and never passes through `errors.ts`,
      // so the error row's `refuseToCache` never sees this route.
      applyCachePolicy({ set, request }, CACHE_POLICIES.readiness);
      const isReady = await ready();
      if (!isReady) {
        set.status = 503;
      }
      return { ready: isReady };
    },
    { detail: { summary: "Readiness — database reachable when configured" } },
  )
  .use(ingestHealth)
  .use(canonicalReads)
  .use(gridRoutes)
  .use(curtailmentRoutes)
  .use(forecastRoutes)
  .use(plantRoutes)
  .use(optimizeRoutes)
  .use(replayRoutes)
  .use(modelCardRoutes)
  .use(voiceRoutes)
  .use(diagnosisRoutes)
  .use(metaRoutes);

// Opt-in BullMQ dashboard at /jobs (requires Redis). Protect it in production.
if (config.dashboard && config.redisUrl) {
  const { jobsDashboard } = await import("./jobs-dashboard.js");
  app.mount("/jobs", jobsDashboard(config.redisUrl));
}

export type App = typeof app;

// Only start the server when run directly (not when imported by tests).
if (import.meta.main) {
  app.listen(config.port, (server) => {
    const url = String(server.url);
    console.log(`🚀 WattSteer API listening on ${url}`);
    console.log(`📚 Docs: ${url}docs`);
    console.log("🔍 Endpoints:");
    console.log("   • GET /          — API info");
    console.log("   • GET /health    — liveness");
    console.log("   • GET /ready     — readiness");
    console.log("   • GET /docs      — Swagger UI");
    console.log("   • GET /ingest/health — ingestion freshness, custody, joins");
    console.log("   • GET /v1/canonical    — the canonical read contract manifest");
    console.log(
      "   • GET /v1/meta         — what this deployment can do, and what is broken",
    );
    console.log("   • GET /v1/grid/now     — the observed right-now readout");
    console.log(
      "   • GET /v1/grid/outlook — four subsystems in one request, national expectation",
    );
    console.log(
      "   • GET /v1/curtailment/{hours,episodes,reasons} — the observed record",
    );
    console.log("   • GET /v1/forecast/day-ahead — the published band, from Postgres");
    console.log(
      "   • GET /v1/diagnosis/day-ahead — the eight driver groups and one paragraph",
    );
    console.log(
      "   • GET /v1/plants       — the plant registry (ODbL §4.6), JSON or CSV",
    );
    console.log(
      "   • POST/GET /v1/optimize — the MILP and the simulator, in one request",
    );
    console.log(
      "   • GET /v1/replay/days   — which days are replayable, and why the rest are not",
    );
    console.log(
      "   • POST/GET /v1/replay   — one past day replayed at its pinned origin",
    );
    console.log(
      "   • GET /v1/model/card    — the reliability curve and the band's coverage, per tail",
    );
    console.log("🔒 Security:");
    console.log("   • Content-Security-Policy (relaxed for /docs)");
    console.log("   • X-Frame-Options: DENY, X-Content-Type-Options: nosniff");
    console.log(`   • XSS protection, Referrer-Policy${isProd ? ", HSTS" : ""}`);
    console.log(
      `   • ${MAX_BODY_BYTES / (1024 * 1024)} MB request body limit ` +
        `(${SOLVE_MAX_BODY_BYTES / 1024} KB on the solve routes), CORS`,
    );
    console.log("🚦 Budgets:");
    console.log(
      `   • read ${config.rateLimitMax}/${config.rateLimitWindowMs / 1000}s/IP · ` +
        `solve ${config.rateLimitSolveMax}/${config.rateLimitWindowMs / 1000}s/IP ` +
        `burst ${config.rateLimitSolveBurst} · narration ${config.narrationDailyCap}/day`,
    );
    console.log(
      `   • counted in ${limitStore.detail}` +
        (limitStore.kind === "memory"
          ? " — with more than one replica the real budget is this × replicas"
          : ""),
    );
    console.log(`   • trusted proxy depth ${config.trustedProxyDepth}`);
    console.log(
      `🧠 Plans: cached in ${optimizeCache.detail}, keyed on ` +
        `scenario + origin + build ${config.optimizerBuild}`,
    );
    console.log(
      `🗄️  Persistence: ${database ? "Postgres (Drizzle)" : "off (no DATABASE_URL)"}`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully…`);
    const force = setTimeout(() => {
      console.error("❌ Forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
    force.unref();
    await app.stop();
    await database?.close().catch(() => {});
    await limitStore.close().catch(() => {});
    await optimizeCache.close().catch(() => {});
    console.log("✅ Server closed");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A rejected promise somewhere must NOT take the whole server down — log it
  // and keep serving every other in-flight request.
  process.on("unhandledRejection", (reason) => {
    console.error("⚠️  Unhandled rejection (continuing):", loggableError(reason));
  });

  // After an uncaught exception the process state is undefined, so the safe
  // move is a graceful shutdown then exit (a supervisor restarts us).
  process.on("uncaughtException", (err) => {
    console.error("💥 Uncaught exception — shutting down:", loggableError(err));
    void shutdown("uncaughtException");
  });
}
