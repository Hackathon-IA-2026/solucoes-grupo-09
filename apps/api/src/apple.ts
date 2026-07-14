import { pageFetch } from "./browser.js";
import type { FetchResult, StoreAdapter } from "./engine.js";
import { UpstreamError } from "./errors.js";
import type {
  AppInfo,
  Review,
  ReviewSort,
  ScrapeOptions,
  VersionRelease,
} from "./types.js";

const STOREFRONT = "https://apps.apple.com";
// Same-origin App Store API proxy. The browser session's cookies are enough —
// apps.apple.com injects the upstream amp-api auth server-side, so we never
// have to scrape or hold a bearer token ourselves.
const REVIEWS_API = `${STOREFRONT}/api/apps/v1/catalog`;
const PAGE_SIZE = 20; // the API hard-caps reviews at 20 per request

// Apple supports two sorts; "rating" has no equivalent, so fall back to recent.
const SORT_MAP: Record<ReviewSort, string> = {
  mostRecent: "mostRecent",
  mostHelpful: "mostHelpful",
  rating: "mostRecent",
};

export function reviewsUrl(opts: ScrapeOptions, offset: number): string {
  const country = (opts.country ?? "us").toLowerCase();
  const params = new URLSearchParams({
    l: opts.lang ?? "en-US",
    offset: String(offset),
    limit: String(PAGE_SIZE),
    platform: "web",
    additionalPlatforms: "appletv,ipad,iphone,mac",
    sort: SORT_MAP[opts.sort ?? "mostRecent"],
  });
  return `${REVIEWS_API}/${country}/apps/${opts.appId}/reviews?${params}`;
}

/** Parse the `offset` query param out of the API's `next` link. */
export function nextOffset(next: string | undefined): number | null {
  if (!next) {
    return null;
  }
  const m = next.match(/[?&]offset=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The subset of Apple's raw review JSON we read. */
interface RawAppleReview {
  id?: string | number;
  attributes?: {
    userName?: string;
    title?: string;
    review?: string;
    rating?: number;
    date?: string;
    isEdited?: boolean;
    developerResponse?: { body?: string; modified?: string } | null;
  };
}

export function normalizeAppleReview(
  raw: RawAppleReview | null | undefined,
  opts: ScrapeOptions,
): Review | null {
  // No id → can't dedupe or persist it (String(undefined) would poison both).
  if (!raw?.attributes || raw.id == null) {
    return null;
  }
  const a = raw.attributes;
  const dev = a.developerResponse;
  return {
    store: "apple",
    id: String(raw.id),
    userName: a.userName ?? "",
    title: a.title ?? "",
    body: a.review ?? "",
    rating: Number(a.rating ?? 0),
    date: a.date ?? "",
    isEdited: Boolean(a.isEdited),
    developerResponse: dev
      ? { body: dev.body ?? "", modified: dev.modified ?? "" }
      : null,
    appId: opts.appId,
    country: (opts.country ?? "us").toLowerCase(),
  };
}

/**
 * Same-origin catalog app resource. `additionalPlatforms` is required or
 * `platformAttributes.ios` (and with it the version history) stays empty —
 * verified live 2026-07-06.
 */
export function appResourceUrl(opts: ScrapeOptions): string {
  const country = (opts.country ?? "us").toLowerCase();
  const params = new URLSearchParams({
    platform: "web",
    l: opts.lang ?? "en-US",
    extend: "versionHistory,userRating",
    additionalPlatforms: "ipad",
  });
  return `${STOREFRONT}/api/apps/v1/catalog/${country}/apps/${opts.appId}?${params}`;
}

/** Cap the history we return — the API can carry dozens of releases. */
const MAX_VERSION_HISTORY = 12;

/**
 * Parse store-wide extras out of the catalog app resource:
 * - `userRating.ratingCountList` → histogram (index 0 = 1★, verified live);
 * - `platformAttributes.ios.versionHistory` → recent releases, newest first;
 * - `releaseDate` → first release.
 * Pure and defensive: any shape surprise degrades to missing fields.
 */
export function parseAppleExtras(body: string): Partial<AppInfo> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return {};
  }
  const attrs = (json as { data?: Array<{ attributes?: Record<string, unknown> }> })
    ?.data?.[0]?.attributes;
  if (!attrs || typeof attrs !== "object") {
    return {};
  }
  const extras: Partial<AppInfo> = {};

  const userRating = attrs.userRating as
    | { value?: unknown; ratingCount?: unknown; ratingCountList?: unknown }
    | undefined;
  const list = userRating?.ratingCountList;
  if (
    Array.isArray(list) &&
    list.length === 5 &&
    list.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  ) {
    extras.histogram = list as number[];
  }
  if (typeof userRating?.ratingCount === "number") {
    extras.ratingCount = userRating.ratingCount;
  }
  if (typeof userRating?.value === "number") {
    extras.averageRating = Math.round(userRating.value * 100) / 100;
  }

  const ios = (attrs.platformAttributes as { ios?: Record<string, unknown> } | undefined)
    ?.ios;
  if (typeof ios?.releaseDate === "string" && ios.releaseDate) {
    extras.released = ios.releaseDate;
  }
  const history = ios?.versionHistory;
  if (Array.isArray(history)) {
    const releases: VersionRelease[] = [];
    for (const entry of history.slice(0, MAX_VERSION_HISTORY)) {
      const e = entry as {
        versionDisplay?: unknown;
        releaseTimestamp?: unknown;
        releaseDate?: unknown;
        releaseNotes?: unknown;
      };
      const version = typeof e.versionDisplay === "string" ? e.versionDisplay : null;
      const released =
        typeof e.releaseTimestamp === "string"
          ? e.releaseTimestamp
          : typeof e.releaseDate === "string"
            ? e.releaseDate
            : null;
      if (!(version && released)) {
        continue;
      }
      releases.push({
        version,
        released,
        notes: typeof e.releaseNotes === "string" ? e.releaseNotes : null,
      });
    }
    if (releases.length > 0) {
      extras.versionHistory = releases;
      extras.updated = releases[0].released;
    }
  }

  // Core identity from the catalog resource (the App Store landing page's
  // JSON-LD omits these, so without this the app shows its id and no icon).
  if (typeof attrs.name === "string" && attrs.name.trim()) {
    extras.name = attrs.name.trim();
  }
  if (typeof attrs.artistName === "string" && attrs.artistName.trim()) {
    extras.developer = attrs.artistName.trim();
  }
  const genres = attrs.genreNames;
  if (Array.isArray(genres) && typeof genres[0] === "string" && genres[0].trim()) {
    extras.category = genres[0].trim();
  }
  const artwork = attrs.artwork as { url?: unknown } | undefined;
  if (artwork && typeof artwork.url === "string") {
    // Artwork URL is a template, e.g. ".../{w}x{h}{c}.{f}".
    extras.icon = artwork.url
      .replace("{w}", "512")
      .replace("{h}", "512")
      .replace("{c}", "bb")
      .replace("{f}", "jpg");
  }

  return extras;
}

export const appleAdapter: StoreAdapter<number> = {
  store: "apple",
  initialCursor: 0,
  landingUrl: (opts) =>
    `${STOREFRONT}/${(opts.country ?? "us").toLowerCase()}/app/id${opts.appId}`,

  async fetchAppExtras(page, opts) {
    const { status, body } = await pageFetch(page, appResourceUrl(opts));
    if (status !== 200) {
      return {};
    }
    return parseAppleExtras(body);
  },

  async fetchBatch(page, opts, offset): Promise<FetchResult<number>> {
    const { status, body } = await pageFetch(page, reviewsUrl(opts, offset));
    if (status === 429) {
      return { kind: "rateLimited" };
    }
    if (status === 404) {
      return { kind: "end" }; // past the last page
    }
    if (status !== 200) {
      throw new UpstreamError(
        `reviews API returned HTTP ${status}: ${body.slice(0, 200)}`,
      );
    }

    let json: { data?: RawAppleReview[]; next?: string };
    try {
      json = JSON.parse(body);
    } catch (err) {
      throw new UpstreamError("App Store reviews response was not valid JSON", {
        cause: err,
      });
    }
    // A 200 reviews response always carries a `data` array — the feed ends with
    // a 404 (handled above). A missing array means the shape changed or we were
    // blocked behind a 200; surface it instead of silently stopping the pull.
    if (!Array.isArray(json.data)) {
      throw new UpstreamError(
        "App Store response missing the reviews array (format change or block)",
      );
    }
    const data = json.data;
    if (data.length === 0) {
      return { kind: "end" };
    }

    const reviews = data
      .map((r) => normalizeAppleReview(r, opts))
      .filter((r): r is Review => r !== null);
    return { kind: "page", reviews, next: nextOffset(json.next) };
  },
};
