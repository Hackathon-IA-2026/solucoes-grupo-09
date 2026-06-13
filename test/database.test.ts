import { afterAll, describe, expect, it } from "bun:test";
import { createDatabase } from "../src/database/connection.js";
import { createReviewRepository } from "../src/database/repository.js";
import type { AppInfo, Review } from "../src/types.js";

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

const appInfo = (over: Partial<AppInfo> = {}): AppInfo => ({
  store: "apple",
  appId: "284882215",
  country: "us",
  name: "Instagram",
  developer: "Instagram, Inc.",
  category: "Photo & Video",
  description: "desc",
  averageRating: 4.7,
  ratingCount: 1234,
  price: 0,
  currency: "USD",
  version: "1.0",
  contentRating: "12+",
  operatingSystem: "iOS",
  icon: "https://x/icon.png",
  url: "https://apps.apple.com/us/app/id1",
  ...over,
});

suite("database · review repository (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const repo = createReviewRepository(handle.db);

  // Schema is applied by `bun run db:push` (see the `test:db` script), so the
  // tables — including `apps` — already exist; no migrate step here.
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

  it("upserts app metadata on (store, appId, country), refreshing the row", async () => {
    await repo.saveApp(appInfo({ appId: "app1", averageRating: 4.1, version: "1.0" }));
    await repo.saveApp(appInfo({ appId: "app1", averageRating: 4.9, version: "2.0" }));

    const rows = (
      await repo.listApps({ store: "apple", appId: "app1", limit: 10 })
    ).filter((a) => a.appId === "app1");
    expect(rows).toHaveLength(1); // upserted, not duplicated
    expect(rows[0].averageRating).toBeCloseTo(4.9); // refreshed
    expect(rows[0].version).toBe("2.0");
  });

  it("keeps separate rows per country for the same app", async () => {
    await repo.saveApp(appInfo({ appId: "app2", country: "us" }));
    await repo.saveApp(appInfo({ appId: "app2", country: "gb" }));
    const rows = await repo.listApps({ store: "apple", appId: "app2", limit: 10 });
    expect(rows.filter((a) => a.appId === "app2").length).toBeGreaterThanOrEqual(2);
  });
});
