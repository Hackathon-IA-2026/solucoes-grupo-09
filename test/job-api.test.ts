import { describe, expect, it } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { Elysia } from "elysia";
import { reviewsRoutes } from "../src/api/reviews/controller.js";
import { createInProcessRunner } from "../src/jobs/inprocess.js";
import type { ScrapeResult } from "../src/types.js";

// Inject a fake runner whose executor returns canned data — exercises the full
// async job API (submit → poll → result) with zero browser involvement.
const fakeRunner = createInProcessRunner(
  async (q): Promise<ScrapeResult> => ({
    store: "google",
    appId: q.appId,
    country: "us",
    count: q.limit ?? 3,
    partial: false,
    reviews: [],
  }),
);
const app = new Elysia().use(reviewsRoutes(fakeRunner));
const api = treaty(app);

describe("api · async jobs (injected runner, no browser)", () => {
  it("submits a job (202) then polls it to completion", async () => {
    const submit = await api.reviews.jobs.post({
      appId: "com.x.y",
      store: "google",
      limit: 6,
    });
    expect(submit.status).toBe(202);
    const id = submit.data?.id;
    expect(typeof id).toBe("string");

    let status: string | undefined;
    let count: number | undefined;
    for (let i = 0; i < 100; i++) {
      const { data } = await api.reviews.jobs({ id: id as string }).get();
      status = data?.status;
      count = data?.result?.count;
      if (status === "completed" || status === "failed") break;
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(status).toBe("completed");
    expect(count).toBe(6);
  });

  it("returns 404 for an unknown job id", async () => {
    const { error } = await api.reviews.jobs({ id: "nope" }).get();
    expect(error?.status).toBe(404);
  });

  it("rejects bad input at submit with 400 (before enqueue)", async () => {
    const { error } = await api.reviews.jobs.post({
      appId: "284882215",
      since: "not-a-date",
    });
    expect(error?.status).toBe(400);
  });
});
