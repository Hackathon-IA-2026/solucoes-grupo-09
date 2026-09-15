import { workbench } from "@getworkbench/elysia";
import { type ConnectionOptions, Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAME, redactedRedisError } from "../jobs/bullmq.js";

/**
 * The BullMQ Workbench dashboard (mount at /jobs). It connects a read handle to
 * the same queue/Redis as the runner. Exposes job data + controls, so it's
 * opt-in (`WATTSTEER_DASHBOARD=true`) and must be protected by auth/network in prod.
 */
export function jobsDashboard(redisUrl: string) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => {
    if (!/connection is closed/i.test(err.message)) {
      // `redactedRedisError`, not `err` — and this module is why that function
      // has a second caller. ioredis hangs the failed command off the error
      // object (`err.command.args` is `["default", "<the password>"]` on an
      // AUTH failure) and Bun's console prints an Error's own properties
      // verbatim, so logging the object writes `REDIS_URL`'s password into the
      // deployment log, where it outlives the rotation meant to retire it.
      //
      // The identical handler in `bullmq.ts` was narrowed when that was found.
      // This one was not, and it is the *more* exposed of the two: it runs only
      // when `WATTSTEER_DASHBOARD` is on, which is the configuration most likely
      // to be turned on by hand, in a hurry, against a password somebody has
      // just typed.
      console.error("dashboard redis error:", redactedRedisError(err));
    }
  });
  const queue = new Queue(QUEUE_NAME, {
    connection: connection as unknown as ConnectionOptions,
  });
  return workbench({ queues: [queue], basePath: "/jobs" });
}
