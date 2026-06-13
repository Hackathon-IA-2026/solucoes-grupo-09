import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
} from "drizzle-orm/pg-core";
import { createSelectSchema } from "drizzle-typebox";
import type { TSchema } from "elysia";

/**
 * Persisted reviews — the durable home for scraped data. Primary key is
 * (store, id) so re-scraping upserts instead of duplicating. Dates are stored
 * as ISO-8601 text (matches the unified `Review` shape, sorts/filters correctly,
 * no timezone surprises).
 */
export const reviews = pgTable(
  "reviews",
  {
    store: text("store").notNull(), // "apple" | "google"
    id: text("id").notNull(), // store's review id
    appId: text("app_id").notNull(),
    country: text("country").notNull(),
    userName: text("user_name").notNull().default(""),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    rating: integer("rating").notNull(),
    date: text("date").notNull().default(""),
    developerResponse: jsonb("developer_response").$type<{
      body: string;
      modified: string;
    } | null>(),
    thumbsUp: integer("thumbs_up"),
    appVersion: text("app_version"),
    isEdited: boolean("is_edited"),
    scrapedAt: text("scraped_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    primaryKey({ columns: [table.store, table.id] }),
    index("reviews_app_idx").on(table.store, table.appId, table.country),
  ],
);

/**
 * Persisted app-level metadata. Primary key is (store, app_id, country) so each
 * storefront entry upserts (the same app differs by country: price, rating,
 * localized name). Floats for price/rating; the rest mirror the `AppInfo` shape.
 */
export const apps = pgTable(
  "apps",
  {
    store: text("store").notNull(), // "apple" | "google"
    appId: text("app_id").notNull(),
    country: text("country").notNull(),
    name: text("name"),
    developer: text("developer"),
    category: text("category"),
    description: text("description"),
    averageRating: real("average_rating"),
    ratingCount: integer("rating_count"),
    price: real("price"),
    currency: text("currency"),
    version: text("version"),
    contentRating: text("content_rating"),
    operatingSystem: text("operating_system"),
    icon: text("icon"),
    url: text("url"),
    scrapedAt: text("scraped_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [primaryKey({ columns: [table.store, table.appId, table.country] })],
);

/** Durable audit of scrape runs (Redis job records expire; these don't). */
export const scrapeRuns = pgTable("scrape_runs", {
  id: text("id").primaryKey(),
  store: text("store").notNull(),
  appId: text("app_id").notNull(),
  country: text("country").notNull(),
  count: integer("count").notNull().default(0),
  partial: boolean("partial").notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// --- drizzle-typebox: the DB table is the single source of truth for the DTO ---
// (Declare an intermediate var per the Elysia doc to avoid infinite type loops.)
// The cast bridges the NodeNext `.d.ts`/`.d.mts` TypeBox type-identity split —
// it's the same TypeBox at runtime, so validation is unaffected.
const _reviewSelect = createSelectSchema(reviews);

/** A stored review row (response model for GET /reviews/stored). */
export const storedReview = _reviewSelect as unknown as TSchema;

const _appSelect = createSelectSchema(apps);

/** A stored app row (response model for GET /apps/stored). */
export const storedApp = _appSelect as unknown as TSchema;
