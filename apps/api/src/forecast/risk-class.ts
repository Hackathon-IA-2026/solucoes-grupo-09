import type { RiskClass } from "@wattsteer/core/api";

/**
 * The named risk class, read off the artifact's published edges.
 *
 * **One classifier, and it lives below the routes.** `/v1/forecast/day-ahead`
 * and `/v1/grid/outlook` already shared this function so that the hero and the
 * detail view cannot put a subsystem in two different classes. The narration
 * payload needs the same answer, and it is assembled by a module that must not
 * import a route: `../api/forecast.ts` builds an Elysia plugin and reaches for
 * the database connection at import time, so borrowing a pure comparison from
 * it would drag a server into a payload builder.
 *
 * So the classifier moved down here, beside the reads it classifies, and every
 * caller imports it from one place. Nothing about the rule itself changed.
 *
 * The edges travel on the response beside the class, so a reader can check the
 * class rather than take it: `risk_bins` is an artifact's published output, not
 * a styling constant.
 */
export function riskClass(
  probability: number,
  elevatedFrom: number,
  highFrom: number,
): RiskClass {
  if (probability >= highFrom) {
    return "high";
  }
  return probability >= elevatedFrom ? "elevated" : "low";
}
