import { createJobRunner } from "../../jobs/index.js";
import { ReviewService } from "./service.js";

/**
 * The process-wide scrape job runner. Backend is chosen from config
 * (BullMQ when `REDIS_URL` is set, else in-process). Both run the same
 * `ReviewService.scrape` executor — its concurrency gate doubles as the
 * per-worker cap, so a BullMQ worker never over-subscribes.
 */
export const jobRunner = createJobRunner((query) => ReviewService.scrape(query));
