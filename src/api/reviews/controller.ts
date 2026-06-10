import { Elysia, t } from "elysia";
import { databasePlugin } from "../../database/plugin.js";
import { storedReview } from "../../database/schema.js";
import { AppError, toHttpError } from "../../errors.js";
import type { JobRunner } from "../../jobs/index.js";
import { reviewModel } from "./model.js";
import { ReviewService } from "./service.js";

const storeEnum = t.Union([t.Literal("apple"), t.Literal("google")]);

/**
 * The reviews controller — an Elysia instance (per best practice, the instance
 * *is* the controller). The job runner is injected so the routes can be tested
 * with a fake runner (no browser). Domain errors map to safe HTTP statuses
 * (400/502/503/504); only 5xx internals are logged.
 */
export function reviewsRoutes(jobRunner: JobRunner) {
  return (
    new Elysia({ name: "reviews.controller", tags: ["Reviews"] })
      .use(reviewModel)
      .use(databasePlugin)
      .get(
        "/reviews",
        async ({ query, status }) => {
          try {
            return await ReviewService.scrape(query);
          } catch (error) {
            const { status: code, body } = toHttpError(error);
            if (code >= 500) console.error("scrape error:", error);
            return status(code, body);
          }
        },
        {
          query: "reviews.query",
          response: {
            200: "reviews.response",
            400: "reviews.error",
            500: "reviews.error",
            502: "reviews.error",
            503: "reviews.error",
            504: "reviews.error",
          },
          detail: {
            summary: "Scrape app reviews (synchronous)",
            description:
              "Drives a humanized cloakbrowser session to fetch reviews from the " +
              "App Store or Google Play. Store auto-detected from the app id unless " +
              "`store` is given. Returns `partial: true` if a timeout or mid-stream " +
              "error cut results short. For large pulls, prefer the async job API.",
          },
        },
      )
      // --- async job API (durable on BullMQ; in-memory otherwise) ---
      .post(
        "/reviews/jobs",
        async ({ body, status }) => {
          try {
            ReviewService.validate(body); // reject bad input before enqueue (400)
            const id = await jobRunner.submit(body);
            return status(202, { id, status: "waiting" as const });
          } catch (error) {
            if (error instanceof AppError) {
              const { status: code, body: errBody } = toHttpError(error);
              return status(code, errBody);
            }
            // Anything else here is queue-backend trouble (e.g. a Redis stall)
            // — transient and retryable, so 503 rather than a generic 500.
            console.error("job submit error:", error);
            return status(503, { error: "Job queue unavailable — try again shortly" });
          }
        },
        {
          body: "reviews.query",
          response: {
            202: "reviews.job.accepted",
            400: "reviews.error",
            500: "reviews.error",
            502: "reviews.error",
            503: "reviews.error",
            504: "reviews.error",
          },
          detail: {
            summary: "Submit an async scrape job",
            description:
              "Enqueues a scrape and returns a job id immediately (202). Poll " +
              "GET /reviews/jobs/:id for status and result. Use this for large pulls " +
              "that would exceed an HTTP request timeout.",
          },
        },
      )
      .get(
        "/reviews/jobs/:id",
        async ({ params, status }) => {
          try {
            const record = await jobRunner.status(params.id);
            if (!record) return status(404, { error: "Job not found" });
            return record;
          } catch (error) {
            // Queue backend unreachable — the job may well exist, so a
            // retryable 503 (not 404/500) is the honest answer.
            console.error("job status error:", error);
            return status(503, { error: "Job queue unavailable — try again shortly" });
          }
        },
        {
          params: t.Object({ id: t.String() }),
          response: { 200: "reviews.job", 404: "reviews.error", 503: "reviews.error" },
          detail: { summary: "Get an async scrape job's status / result" },
        },
      )
      // --- query persisted reviews from Postgres (no browser) ---
      .get(
        "/reviews/stored",
        async ({ query, reviewStore, status }) => {
          if (!reviewStore) {
            return status(503, {
              error: "Persistence not configured (set DATABASE_URL)",
            });
          }
          try {
            return await reviewStore.listReviews({
              store: query.store,
              appId: query.appId,
              country: query.country,
              limit: query.limit ?? 50,
            });
          } catch (error) {
            // Database unreachable — transient and retryable, so 503.
            console.error("stored reviews query error:", error);
            return status(503, {
              error: "Review storage unavailable — try again shortly",
            });
          }
        },
        {
          query: t.Object({
            appId: t.Optional(t.String()),
            store: t.Optional(storeEnum),
            country: t.Optional(t.String({ pattern: "^[A-Za-z]{2}$" })),
            limit: t.Optional(t.Numeric({ default: 50, minimum: 1, maximum: 500 })),
          }),
          response: { 200: t.Array(storedReview), 503: "reviews.error" },
          detail: {
            summary: "Query persisted reviews (durable, no scrape)",
            description:
              "Reads reviews already saved to Postgres by prior scrapes. Fast, no " +
              "browser. Requires DATABASE_URL.",
          },
        },
      )
  );
}
