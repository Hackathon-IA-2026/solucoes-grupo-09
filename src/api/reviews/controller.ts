import { Elysia } from "elysia";
import { toHttpError } from "../../errors.js";
import { reviewModel } from "./model.js";
import { ReviewService } from "./service.js";

/**
 * The reviews controller — an Elysia instance (per best practice, the instance
 * *is* the controller). It wires the route to the service and maps domain
 * errors to safe HTTP statuses (400/502/503/504), logging only 5xx internals.
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
        summary: "Scrape app reviews",
        description:
          "Drives a humanized cloakbrowser session to fetch reviews for an app " +
          "from the App Store or Google Play. The store is auto-detected from the " +
          "app id unless `store` is given. Larger `limit` values take longer. " +
          "Returns `partial: true` if a timeout or mid-stream error cut results short.",
      },
    },
  );
