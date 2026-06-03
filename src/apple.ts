import { pageFetch } from "./browser.js";
import type { FetchResult, StoreAdapter } from "./engine.js";
import type { Review, ReviewSort, ScrapeOptions } from "./types.js";

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
  if (!next) return null;
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
  if (!raw?.attributes) return null;
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

export const appleAdapter: StoreAdapter<number> = {
  store: "apple",
  initialCursor: 0,
  landingUrl: (opts) =>
    `${STOREFRONT}/${(opts.country ?? "us").toLowerCase()}/app/id${opts.appId}`,

  async fetchBatch(page, opts, offset): Promise<FetchResult<number>> {
    const { status, body } = await pageFetch(page, reviewsUrl(opts, offset));
    if (status === 429) return { kind: "rateLimited" };
    if (status === 404) return { kind: "end" }; // past the last page
    if (status !== 200) {
      throw new Error(`reviews API returned HTTP ${status}: ${body.slice(0, 200)}`);
    }

    const json = JSON.parse(body) as { data?: RawAppleReview[]; next?: string };
    const data = json.data ?? [];
    if (data.length === 0) return { kind: "end" };

    const reviews = data
      .map((r) => normalizeAppleReview(r, opts))
      .filter((r): r is Review => r !== null);
    return { kind: "page", reviews, next: nextOffset(json.next) };
  },
};
