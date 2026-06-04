import { Elysia } from "elysia";
import { reviewRepository } from "./repository.js";

/**
 * Decorates the review repository onto the Elysia context as `store` so routes
 * can read persisted data via DI (`ctx.store`). It is `null` when no database
 * is configured — handlers should treat that as "persistence disabled".
 */
export const databasePlugin = new Elysia({ name: "database" }).decorate(
  "reviewStore",
  reviewRepository,
);
