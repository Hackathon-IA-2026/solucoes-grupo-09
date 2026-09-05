import { config } from "../../config.js";
import { createLimitStore, type LimitStore } from "./limit-store.js";

/**
 * The one counter this process spends every budget against.
 *
 * It used to be a `const` in `../index.ts`, which is the module that mounts the
 * routes — so a route that needed the counter could not import it without
 * importing the app that imports the route. The handle moves here, and
 * `../index.ts` re-exports it so nothing outside has to know that it did.
 *
 * There is exactly one, on purpose. Two stores would be two Redis connections
 * and — with no `REDIS_URL` — two maps, at which point the rate limiter and the
 * narration's daily cap would each be counting against a budget the other
 * cannot see. The boot log states which kind it is for the same reason: "the
 * published budget is the real budget" is not something an operator should have
 * to infer.
 */
export const limitStore: LimitStore = createLimitStore(config.redisUrl);
