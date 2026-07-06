import { and, desc, eq, sql } from "drizzle-orm";
import type { AppInfo, Review, ScrapeResult, Store } from "../types.js";
import type { Database } from "./connection.js";
import { database } from "./connection.js";
import { apps, reviews, scrapeRuns } from "./schema.js";

export type StoredReview = typeof reviews.$inferSelect;
export type StoredApp = typeof apps.$inferSelect;

export interface ListFilter {
  store?: Store;
  appId?: string;
  country?: string;
  limit: number;
}

export interface AppFilter {
  store?: Store;
  appId?: string;
  country?: string;
  limit: number;
}

export interface ReviewRepository {
  /** Upsert reviews (dedup on store+id); returns the number written. */
  saveReviews(rows: Review[]): Promise<number>;
  /** Query persisted reviews, newest first. */
  listReviews(filter: ListFilter): Promise<StoredReview[]>;
  /** Append a durable record of a scrape run. */
  recordRun(run: { id: string } & ScrapeResult): Promise<void>;
  /** Upsert one app's metadata (dedup on store+appId+country). */
  saveApp(info: AppInfo): Promise<void>;
  /** Query persisted app metadata, most-recently-scraped first. */
  listApps(filter: AppFilter): Promise<StoredApp[]>;
}

export function createReviewRepository(db: Database): ReviewRepository {
  return {
    async saveReviews(rows) {
      if (rows.length === 0) return 0;
      const values = rows.map((r) => ({
        store: r.store,
        id: r.id,
        appId: r.appId,
        country: r.country,
        userName: r.userName,
        title: r.title,
        body: r.body,
        rating: r.rating,
        date: r.date,
        developerResponse: r.developerResponse,
        thumbsUp: r.thumbsUp ?? null,
        appVersion: r.appVersion ?? null,
        isEdited: r.isEdited ?? null,
      }));
      // Re-scraping refreshes the row (e.g. a new developer response) rather
      // than inserting a duplicate. Chunked so a large library-side pull can't
      // exceed Postgres's 65,534 bind-parameter cap (13 params per row).
      const CHUNK = 1_000;
      for (let i = 0; i < values.length; i += CHUNK) {
        await db
          .insert(reviews)
          .values(values.slice(i, i + CHUNK))
          .onConflictDoUpdate({
            target: [reviews.store, reviews.id],
            set: {
              appId: sql`excluded.app_id`,
              country: sql`excluded.country`,
              userName: sql`excluded.user_name`,
              title: sql`excluded.title`,
              body: sql`excluded.body`,
              rating: sql`excluded.rating`,
              date: sql`excluded.date`,
              developerResponse: sql`excluded.developer_response`,
              thumbsUp: sql`excluded.thumbs_up`,
              appVersion: sql`excluded.app_version`,
              isEdited: sql`excluded.is_edited`,
              scrapedAt: sql`excluded.scraped_at`,
            },
          });
      }
      return values.length;
    },

    async listReviews({ store, appId, country, limit }) {
      const conds = [];
      if (store) conds.push(eq(reviews.store, store));
      if (appId) conds.push(eq(reviews.appId, appId));
      if (country) conds.push(eq(reviews.country, country.toLowerCase()));
      return db
        .select()
        .from(reviews)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(reviews.date))
        .limit(limit);
    },

    async recordRun(run) {
      await db.insert(scrapeRuns).values({
        id: run.id,
        store: run.store,
        appId: run.appId,
        country: run.country,
        count: run.count,
        partial: run.partial,
      });
    },

    async saveApp(info) {
      // Re-scraping refreshes the row (price/rating drift over time) rather than
      // duplicating; one row per storefront (store, appId, country).
      await db
        .insert(apps)
        .values({
          store: info.store,
          appId: info.appId,
          country: info.country,
          name: info.name,
          developer: info.developer,
          category: info.category,
          description: info.description,
          averageRating: info.averageRating,
          ratingCount: info.ratingCount,
          price: info.price,
          currency: info.currency,
          version: info.version,
          contentRating: info.contentRating,
          operatingSystem: info.operatingSystem,
          icon: info.icon,
          url: info.url,
        })
        .onConflictDoUpdate({
          target: [apps.store, apps.appId, apps.country],
          set: {
            name: sql`excluded.name`,
            developer: sql`excluded.developer`,
            category: sql`excluded.category`,
            description: sql`excluded.description`,
            averageRating: sql`excluded.average_rating`,
            ratingCount: sql`excluded.rating_count`,
            price: sql`excluded.price`,
            currency: sql`excluded.currency`,
            version: sql`excluded.version`,
            contentRating: sql`excluded.content_rating`,
            operatingSystem: sql`excluded.operating_system`,
            icon: sql`excluded.icon`,
            url: sql`excluded.url`,
            scrapedAt: sql`excluded.scraped_at`,
          },
        });
    },

    async listApps({ store, appId, country, limit }) {
      const conds = [];
      if (store) conds.push(eq(apps.store, store));
      if (appId) conds.push(eq(apps.appId, appId));
      if (country) conds.push(eq(apps.country, country.toLowerCase()));
      return db
        .select()
        .from(apps)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(apps.scrapedAt))
        .limit(limit);
    },
  };
}

/** Process-wide repository, or `null` when no database is configured. */
export const reviewRepository: ReviewRepository | null = database
  ? createReviewRepository(database.db)
  : null;
