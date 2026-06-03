import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { reviews } from "./reviews/controller.js";

/**
 * The noviq HTTP API. Composed from feature modules (each a controller +
 * service + model) via `.use()`, with Swagger/OpenAPI docs at `/docs`.
 */
export const app = new Elysia()
  .use(
    swagger({
      path: "/docs",
      documentation: {
        info: {
          title: "noviq API",
          version: "0.1.0",
          description:
            "Humanized App Store & Google Play review scraper, powered by cloakbrowser.",
        },
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
  app.listen(port, ({ url }) => {
    console.log(`noviq API listening on ${url} — docs at ${url}docs`);
  });
}
