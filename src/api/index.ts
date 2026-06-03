import { cors } from "@elysiajs/cors";
import { serverTiming } from "@elysiajs/server-timing";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { bodyLimit, MAX_BODY_BYTES } from "./plugins/body-limit.js";
import { errorHandler } from "./plugins/errors.js";
import { securityHeaders } from "./plugins/security.js";
import { reviews } from "./reviews/controller.js";

const isProd = process.env.NODE_ENV === "production";

/**
 * The noviq HTTP API. Composed from feature modules (each a controller +
 * service + model) and cross-cutting plugins (security headers, body limit,
 * CORS, server timing) via `.use()`, with Swagger/OpenAPI docs at `/docs`.
 */
export const app = new Elysia()
  .use(securityHeaders)
  .use(bodyLimit())
  .use(
    cors({
      origin: !isProd,
      methods: ["GET"],
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
        servers: [{ url: "http://localhost:3000", description: "Local" }],
        tags: [{ name: "Reviews", description: "Scrape app store reviews" }],
      },
    }),
  )
  .get("/", () => ({ name: "noviq", version: "0.1.0", docs: "/docs" }), {
    detail: { summary: "API info" },
  })
  .get("/health", () => ({ status: "ok" as const }), {
    detail: { summary: "Health check" },
  })
  .use(reviews);

export type App = typeof app;

// Only start the server when run directly (not when imported by tests).
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);

  app.listen(port, (server) => {
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
  });

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully…`);
    const force = setTimeout(() => {
      console.error("❌ Forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
    force.unref();
    await app.stop();
    console.log("✅ Server closed");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    console.error("💥 Uncaught exception:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("💥 Unhandled rejection:", reason);
    process.exit(1);
  });
}
