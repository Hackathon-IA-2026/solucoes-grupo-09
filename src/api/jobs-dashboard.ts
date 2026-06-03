import { workbench } from "@getworkbench/elysia";
import { type ConnectionOptions, Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAME } from "../jobs/bullmq.js";

/**
 * The BullMQ Workbench dashboard (mount at /jobs). It connects a read handle to
 * the same queue/Redis as the runner. Exposes job data + controls, so it's
 * opt-in (`NOVIQ_DASHBOARD=true`) and must be protected by auth/network in prod.
 */
export function jobsDashboard(redisUrl: string) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => {
    if (!/connection is closed/i.test(err.message)) {
      console.error("dashboard redis error:", err);
    }
  });
  const queue = new Queue(QUEUE_NAME, {
    connection: connection as unknown as ConnectionOptions,
  });
  return workbench({ queues: [queue], basePath: "/jobs" });
}
