import { parseAppInfo } from "./appinfo.js";
import type { AppInfo, ScrapeOptions, Store } from "./types.js";

/**
 * Fast, browser-free app-metadata lookup for the live preview (`GET /app`).
 * The full review scrape still uses the stealth browser; the preview only
 * needs name/icon/rating, which public HTTP endpoints return in ~200ms:
 *   - Apple: the iTunes Lookup API (JSON, complete: name, icon, rating…).
 *   - Google: a plain page GET, reusing the shared JSON-LD parser.
 * Both degrade to `null` on any failure so `getAppInfo` can fall back to the
 * browser path.
 */

const FAST_TIMEOUT_MS = 8000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const JSONLD_RE =
  /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

async function fetchText(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function s(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Apple metadata via the public iTunes Lookup API. */
async function appleFast(opts: ScrapeOptions): Promise<AppInfo | null> {
  const country = (opts.country ?? "us").toLowerCase();
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(opts.appId)}&country=${country}&entity=software`;
  const res = await fetchText(url);
  if (!res || res.status !== 200) {
    return null;
  }
  let json: { results?: Array<Record<string, unknown>> };
  try {
    json = JSON.parse(res.body);
  } catch {
    return null;
  }
  const r = json.results?.[0];
  if (!r) {
    return null;
  }
  let icon: string | null = null;
  if (typeof r.artworkUrl512 === "string") {
    icon = r.artworkUrl512;
  } else if (typeof r.artworkUrl100 === "string") {
    icon = r.artworkUrl100.replace("100x100", "512x512");
  } else if (typeof r.artworkUrl60 === "string") {
    icon = r.artworkUrl60.replace("60x60", "512x512");
  }
  return {
    store: "apple",
    appId: opts.appId,
    country,
    name: s(r.trackName),
    developer: s(r.artistName),
    category: s(r.primaryGenreName),
    description: s(r.description),
    averageRating:
      typeof r.averageUserRating === "number" ? round2(r.averageUserRating) : null,
    ratingCount: typeof r.userRatingCount === "number" ? r.userRatingCount : null,
    price: typeof r.price === "number" ? r.price : null,
    currency: s(r.currency),
    version: s(r.version),
    contentRating: s(r.contentAdvisoryRating),
    operatingSystem: "iOS",
    icon,
    url: s(r.trackViewUrl),
    histogram: null,
    installs: null,
    installsText: null,
    released: s(r.releaseDate),
    updated: s(r.currentVersionReleaseDate),
    versionHistory: null,
  };
}

/** Google metadata via a plain page GET + the shared JSON-LD parser. */
async function googleFast(opts: ScrapeOptions): Promise<AppInfo | null> {
  const country = (opts.country ?? "us").toLowerCase();
  const lang = opts.lang ?? "en";
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(opts.appId)}&hl=${encodeURIComponent(lang)}&gl=${encodeURIComponent(country)}`;
  const res = await fetchText(url, {
    "User-Agent": UA,
    "Accept-Language": `${lang},en;q=0.9`,
  });
  if (!res || res.status !== 200) {
    return null;
  }
  const scripts: string[] = [];
  for (const match of res.body.matchAll(JSONLD_RE)) {
    scripts.push(match[1]);
  }
  if (scripts.length === 0) {
    return null;
  }
  return parseAppInfo(scripts, { store: "google", appId: opts.appId, country });
}

/** Browser-free metadata lookup; `null` when the fast path can't resolve it. */
export function fetchAppInfoFast(
  opts: ScrapeOptions,
  store: Store,
): Promise<AppInfo | null> {
  return store === "apple" ? appleFast(opts) : googleFast(opts);
}
