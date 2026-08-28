import { cors } from "@elysiajs/cors";
import { serverTiming } from "@elysiajs/server-timing";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { config } from "../config.js";
import { database } from "../database/connection.js";
import { mlProxy } from "./ml-proxy.js";
import { bodyLimit, MAX_BODY_BYTES } from "./plugins/body-limit.js";
import { errorHandler } from "./plugins/errors.js";
import { rateLimit } from "./plugins/rate-limit.js";
import { requestContext } from "./plugins/request-context.js";
import { securityHeaders } from "./plugins/security.js";

const isProd = config.isProd;

/** Paths exempt from rate limiting — cheap probes and docs. */
const UNMETERED = new Set(["/", "/health", "/ready"]);

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
 * There are no domain routes yet — the WattSteer surface was removed and
 * WattSteer's arrives with the data platform.
 */
export const app = new Elysia()
  .use(securityHeaders)
  .use(requestContext)
  .use(bodyLimit())
  .use(
    rateLimit({
      max: config.rateLimitMax,
      windowMs: config.rateLimitWindowMs,
      // Probes and docs stay free so a monitor is never throttled.
      counts: (_method, pathname) =>
        !(UNMETERED.has(pathname) || pathname.startsWith("/docs")),
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
  .use(mlProxy);

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
    console.log("🔒 Security:");
    console.log("   • Content-Security-Policy (relaxed for /docs)");
    console.log("   • X-Frame-Options: DENY, X-Content-Type-Options: nosniff");
    console.log(`   • XSS protection, Referrer-Policy${isProd ? ", HSTS" : ""}`);
    console.log(`   • ${MAX_BODY_BYTES / (1024 * 1024)} MB request body limit, CORS`);
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
