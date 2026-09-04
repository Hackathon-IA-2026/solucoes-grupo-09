import { cors } from "@elysiajs/cors";
import { serverTiming } from "@elysiajs/server-timing";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { config } from "../config.js";
import { database } from "../database/connection.js";
import { canonicalReads } from "./canonical.js";
import { curtailmentRoutes } from "./curtailment.js";
import { forecastRoutes } from "./forecast.js";
import { gridRoutes } from "./grid.js";
import { ingestHealth } from "./ingest-health.js";
import { metaRoutes } from "./meta.js";
import { optimizeCache, optimizeRoutes } from "./optimize.js";
import { plantRoutes } from "./plants.js";
import {
  bodyLimit,
  MAX_BODY_BYTES,
  SOLVE_MAX_BODY_BYTES,
  solveBodyLimit,
} from "./plugins/body-limit.js";
import { errorHandler } from "./plugins/errors.js";
import { createLimitStore } from "./plugins/limit-store.js";
import { rateLimit, tiersFrom } from "./plugins/rate-limit.js";
import { requestContext } from "./plugins/request-context.js";
import { securityHeaders } from "./plugins/security.js";

const isProd = config.isProd;

/**
 * Where the budgets are counted: Redis when one is configured, so two API
 * replicas share one budget, and the per-process map otherwise. The boot log
 * says which, because "the published budget is the real budget" is not
 * something an operator should have to infer.
 */
export const limitStore = createLimitStore(config.redisUrl);

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
  .get("/", () => ({ name: "wattsteer", version: "0.1.0", docs: "/docs" }), {
    detail: { summary: "API info" },
  })
  .get("/health", () => ({ status: "ok" as const }), {
    detail: { summary: "Liveness" },
  })
  .get(
    "/ready",
    async ({ set }) => {
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
      "   • GET /v1/plants       — the plant registry (ODbL §4.6), JSON or CSV",
    );
    console.log(
      "   • POST/GET /v1/optimize — the MILP and the simulator, in one request",
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
    console.error("⚠️  Unhandled rejection (continuing):", reason);
  });

  // After an uncaught exception the process state is undefined, so the safe
  // move is a graceful shutdown then exit (a supervisor restarts us).
  process.on("uncaughtException", (err) => {
    console.error("💥 Uncaught exception — shutting down:", err);
    void shutdown("uncaughtException");
  });
}
