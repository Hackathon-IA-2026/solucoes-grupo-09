import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createDatabase } from "../src/database/connection.js";
import { createReviewRepository } from "../src/database/repository.js";
import type { Review } from "../src/types.js";

// Runs only with a test Postgres (the `test:db` script sets it).
// Spin one up: docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=noviq -e POSTGRES_DB=noviq postgres:16-alpine
const URL = process.env.NOVIQ_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const review = (over: Partial<Review> = {}): Review => ({
  store: "apple",
  id: "r1",
  userName: "u",
  title: "t",
  body: "b",
  rating: 5,
  date: "2025-01-01T00:00:00.000Z",
  developerResponse: null,
  appId: "284882215",
  country: "us",
  ...over,
});

suite("database · review repository (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const repo = createReviewRepository(handle.db);

  beforeAll(() => handle.migrate());
  afterAll(() => handle.close());

  it("upserts and dedupes on (store, id), refreshing the row", async () => {
    const r = review({ id: "u1", body: "first" });
    expect(await repo.saveReviews([r])).toBe(1);
    await repo.saveReviews([
      { ...r, body: "updated", developerResponse: { body: "ty", modified: "x" } },
    ]);

    const mine = (
      await repo.listReviews({ store: "apple", appId: "284882215", limit: 100 })
    ).filter((x) => x.id === "u1");
    expect(mine).toHaveLength(1); // deduped, not duplicated
    expect(mine[0].body).toBe("updated"); // refreshed
    expect(mine[0].developerResponse).toEqual({ body: "ty", modified: "x" });
  });

  it("filters by store/appId", async () => {
    await repo.saveReviews([review({ id: "g1", store: "google", appId: "com.x.y" })]);
    const rows = await repo.listReviews({ store: "google", appId: "com.x.y", limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((x) => x.store === "google")).toBe(true);
  });

  it("saveReviews([]) is a no-op", async () => {
    expect(await repo.saveReviews([])).toBe(0);
  });

  it("records a scrape run", async () => {
    await repo.recordRun({
      id: crypto.randomUUID(),
      store: "apple",
      appId: "284882215",
      country: "us",
      count: 3,
      partial: false,
      reviews: [],
    });
  });
});
