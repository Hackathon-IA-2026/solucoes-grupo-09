import { Elysia } from "elysia";
import { reviewModel } from "./model.js";
import { ReviewService } from "./service.js";

/**
 * The reviews controller — an Elysia instance (per best practice, the instance
 * *is* the controller). It wires routes to the service and references the
 * named models for validation and OpenAPI docs.
 */
export const reviews = new Elysia({
  name: "reviews.controller",
  tags: ["Reviews"],
})
  .use(reviewModel)
  .get(
    "/reviews",
    async ({ query, status }) => {
      try {
        return await ReviewService.scrape(query);
      } catch (error) {
        return status(400, {
          error: error instanceof Error ? error.message : "Bad request",
        });
      }
    },
    {
      query: "reviews.query",
      response: {
        200: "reviews.response",
        400: "reviews.error",
      },
      detail: {
        summary: "Scrape app reviews",
        description:
          "Drives a humanized cloakbrowser session to fetch reviews for an app " +
          "from the App Store or Google Play. The store is auto-detected from the " +
          "app id unless `store` is given. Larger `limit` values take longer.",
      },
    },
  );
