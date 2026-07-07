import { cors } from "@elysiajs/cors";
import { serverTiming } from "@elysiajs/server-timing";
import { swagger } from "@elysiajs/swagger";
import { binaryInfo } from "cloakbrowser";
import { Elysia } from "elysia";
import { config } from "../config.js";
import { database } from "../database/connection.js";
import { bodyLimit, MAX_BODY_BYTES } from "./plugins/body-limit.js";
import { errorHandler } from "./plugins/errors.js";
import { rateLimit } from "./plugins/rate-limit.js";
import { requestContext } from "./plugins/request-context.js";
import { securityHeaders } from "./plugins/security.js";
import { reviewsRoutes } from "./reviews/controller.js";
import { jobRunner } from "./reviews/runner.js";
import { scrapeStats } from "./reviews/service.js";

const isProd = config.isProd;

/** Readiness: the Chromium binary must resolve before we accept traffic. */
async function browserReady(): Promise<boolean> {
  if (process.env.CLOAKBROWSER_BINARY_PATH) {
    return true; // container: baked in
  }
  try {
    return Boolean((await binaryInfo())?.installed);
  } catch {
    return false;
  }
}

/**
 * The noviq HTTP API. Composed from feature modules (each a controller +
 * service + model) and cross-cutting plugins (security headers, body limit,
 * CORS, server timing) via `.use()`, with Swagger/OpenAPI docs at `/docs`.
 */
export const app = new Elysia()
  .use(securityHeaders)
  .use(requestContext)
  .use(bodyLimit())
  .use(
    // Scrape *submissions* only — each one may launch a Chromium. Cheap reads
    // (job polling, stored reviews, /, /health, /ready, /docs) are exempt so
    // a legitimate client polling its job is never throttled.
    rateLimit({
      max: config.rateLimitMax,
      windowMs: config.rateLimitWindowMs,
      counts: (method, pathname) =>
        (method === "GET" && (pathname === "/reviews" || pathname === "/app")) ||
        (method === "POST" && pathname === "/reviews/jobs"),
    }),
  )
  .use(
    cors({
      // Dev: any origin (local Expo web runs on arbitrary ports). Prod: only
      // the origins listed in NOVIQ_CORS_ORIGINS — the deployed web app's
      // origin must be there or its browser calls fail preflight.
      origin: isProd ? config.corsOrigins : true,
      // POST is required by the async job API (POST /reviews/jobs).
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
          title: "noviq API",
          version: "0.1.0",
          description:
            "Humanized App Store & Google Play review scraper, powered by cloakbrowser. " +
            "Drives a stealth browser session to fetch reviews from either store.",
          contact: { name: "noviq" },
          license: { name: "MIT" },
        },
        // No hardcoded server: Swagger UI uses the origin it was loaded from, so
        // "Execute" hits the right host on localhost and in production alike.
        // Set NOVIQ_PUBLIC_URL to pin it explicitly.
        ...(config.publicUrl
          ? { servers: [{ url: config.publicUrl, description: "Public" }] }
          : {}),
        tags: [{ name: "Reviews", description: "Scrape app store reviews" }],
      },
    }),
  )
  .get("/", () => ({ name: "noviq", version: "0.1.0", docs: "/docs" }), {
    detail: { summary: "API info" },
  })
  .get("/health", () => ({ status: "ok" as const, scrapes: scrapeStats() }), {
    detail: { summary: "Liveness + live scrape concurrency stats" },
  })
  .get(
    "/ready",
    async ({ set }) => {
      const ready = await browserReady();
      if (!ready) {
        set.status = 503;
      }
      return { ready };
    },
    { detail: { summary: "Readiness — Chromium binary available" } },
  )
  .use(reviewsRoutes(jobRunner));

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
    console.log(`🚀 noviq API listening on ${url}`);
    console.log(`📚 Docs: ${url}docs`);
    console.log("🔍 Endpoints:");
    console.log("   • GET /          — API info");
    console.log("   • GET /health    — health check");
    console.log("   • GET /reviews   — scrape App Store / Google Play reviews");
    console.log("   • GET /docs      — Swagger UI");
    console.log("🔒 Security:");
    console.log("   • Content-Security-Policy (relaxed for /docs)");
    console.log("   • X-Frame-Options: DENY, X-Content-Type-Options: nosniff");
    console.log(`   • XSS protection, Referrer-Policy${isProd ? ", HSTS" : ""}`);
    console.log(`   • ${MAX_BODY_BYTES / (1024 * 1024)} MB request body limit, CORS`);
    console.log(
      `⚙️  Job runner: ${jobRunner.mode}${config.redisUrl ? ` (Redis, role=${config.role})` : ""}`,
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
    await jobRunner.close().catch(() => {});
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
