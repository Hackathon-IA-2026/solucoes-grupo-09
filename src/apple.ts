import { launch, launchPersistentContext } from "cloakbrowser";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type {
  AppleReview,
  ScrapeOptions,
  StealthPreset,
  StealthProfile,
} from "./types.js";

const STOREFRONT = "https://apps.apple.com";
// Same-origin App Store API proxy. The browser session's cookies are enough —
// apps.apple.com injects the upstream amp-api auth server-side, so we never
// have to scrape or hold a bearer token ourselves.
const REVIEWS_API = `${STOREFRONT}/api/apps/v1/catalog`;
const PAGE_SIZE = 20; // the API hard-caps reviews at 20 per request

const STEALTH: Record<StealthPreset, StealthProfile> = {
  max: {
    humanize: true,
    pageDelayMs: [1400, 3200],
    warmupScroll: true,
    maxRetries: 5,
    backoffBaseMs: 10_000,
  },
  balanced: {
    humanize: true,
    pageDelayMs: [600, 1400],
    warmupScroll: false,
    maxRetries: 4,
    backoffBaseMs: 6_000,
  },
  fast: {
    humanize: false,
    pageDelayMs: [150, 400],
    warmupScroll: false,
    maxRetries: 3,
    backoffBaseMs: 3_000,
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Random delay in an inclusive [min, max] window — avoids fixed cadence. */
function jitter([min, max]: [number, number]): Promise<void> {
  return sleep(min + Math.random() * (max - min));
}

interface Session {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Open a cloakbrowser session and navigate to the app's storefront page like a
 * human. Doing the API calls from this same browser context means they inherit
 * the real fingerprint, cookies, Origin and Referer of an actual visit — far
 * harder to flag than a bare HTTP client.
 */
async function openSession(
  opts: ScrapeOptions,
  profile: StealthProfile,
): Promise<Session> {
  const country = (opts.country ?? "us").toLowerCase();
  const launchOpts = {
    headless: !opts.headed,
    humanize: profile.humanize,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    ...(opts.geoip ? { geoip: true } : {}),
  };

  let browser: Browser | null = null;
  let context: BrowserContext;
  if (opts.profileDir) {
    context = await launchPersistentContext({
      userDataDir: opts.profileDir,
      ...launchOpts,
    });
  } else {
    browser = await launch(launchOpts);
    context = await browser.newContext();
  }

  const page = await context.newPage();
  const landing = `${STOREFRONT}/${country}/app/id${opts.appId}`;
  const resp = await page.goto(landing, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  if (resp && resp.status() >= 400) {
    await closeSession(browser, context);
    throw new Error(
      `App Store returned HTTP ${resp.status()} for app ${opts.appId} ` +
        `(${country}). Check the app id and country code.`,
    );
  }

  if (profile.warmupScroll) {
    // Mimic a visitor skimming the page before we start fetching.
    await jitter([500, 1200]);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 600 + Math.random() * 400);
      await jitter([300, 900]);
    }
  } else {
    // Give the SPA a moment to settle the session cookies.
    await sleep(800);
  }

  return { context, page, close: () => closeSession(browser, context) };
}

async function closeSession(
  browser: Browser | null,
  context: BrowserContext,
): Promise<void> {
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}

interface RawFetch {
  status: number;
  body: string;
}

/** Run the reviews fetch from inside the page so it carries page-origin context. */
async function fetchPage(page: Page, url: string): Promise<RawFetch> {
  return page.evaluate(async (url) => {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    return { status: res.status, body: await res.text() };
  }, url);
}

function buildUrl(opts: ScrapeOptions, offset: number): string {
  const country = (opts.country ?? "us").toLowerCase();
  const params = new URLSearchParams({
    l: opts.lang ?? "en-US",
    offset: String(offset),
    limit: String(PAGE_SIZE),
    platform: "web",
    additionalPlatforms: "appletv,ipad,iphone,mac",
    sort: opts.sort ?? "mostRecent",
  });
  return `${REVIEWS_API}/${country}/apps/${opts.appId}/reviews?${params}`;
}

/** Parse the `offset` query param out of the API's `next` link. */
function nextOffset(next: string | undefined): number | null {
  if (!next) return null;
  const m = next.match(/[?&]offset=(\d+)/);
  return m ? Number(m[1]) : null;
}

function normalize(
  raw: any,
  appId: string,
  country: string,
): AppleReview | null {
  const a = raw?.attributes;
  if (!a) return null;
  const dev = a.developerResponse;
  return {
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
    appId,
    country,
  };
}

/**
 * Stream App Store reviews one at a time. This is the core primitive — the
 * array and file helpers are thin wrappers over it, so you can pipe results
 * straight into a DB or queue without buffering everything in memory.
 */
export async function* streamAppleReviews(
  opts: ScrapeOptions,
): AsyncGenerator<AppleReview, void, unknown> {
  if (!opts.appId) throw new Error("appId is required");
  const profile = STEALTH[opts.stealth ?? "max"];
  const country = (opts.country ?? "us").toLowerCase();
  const since = opts.since ? new Date(opts.since).getTime() : null;

  const session = await openSession(opts, profile);
  // Apple's offset pagination can return the same review twice — e.g. when new
  // reviews arrive mid-scrape and shift every later offset by one. Track ids so
  // each review is emitted at most once.
  const seen = new Set<string>();
  let collected = 0;
  let offset = 0;
  let dryPages = 0; // consecutive pages that added nothing new

  try {
    while (true) {
      const url = buildUrl(opts, offset);
      const { status, body } = await fetchWithRetry(session.page, url, profile);

      // 404 is the API's way of saying "no more pages".
      if (status === 404) break;
      if (status !== 200) {
        throw new Error(
          `reviews API returned HTTP ${status}: ${body.slice(0, 200)}`,
        );
      }

      const json = JSON.parse(body);
      const data: any[] = json.data ?? [];
      if (data.length === 0) break;

      let stop = false;
      const before = collected;
      for (const raw of data) {
        const review = normalize(raw, opts.appId, country);
        if (!review) continue;
        if (seen.has(review.id)) continue; // drop duplicates across pages
        seen.add(review.id);

        if (since && review.date && new Date(review.date).getTime() < since) {
          stop = true;
          break;
        }

        yield review;
        opts.onReview?.(review, collected);
        collected++;

        if (opts.limit && collected >= opts.limit) {
          stop = true;
          break;
        }
      }

      // If a page is entirely duplicates, the feed has likely wrapped or
      // bottomed out — bail after two such pages in a row.
      dryPages = collected === before ? dryPages + 1 : 0;

      const next = nextOffset(json.next);
      opts.onProgress?.({ collected, batch: data.length, nextOffset: next });
      if (stop || next === null || dryPages >= 2) break;

      offset = next;
      await jitter(profile.pageDelayMs);
    }
  } finally {
    await session.close();
  }
}

async function fetchWithRetry(
  page: Page,
  url: string,
  profile: StealthProfile,
): Promise<RawFetch> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchPage(page, url);
    if (res.status !== 429) return res;
    if (attempt > profile.maxRetries) return res;
    await sleep(profile.backoffBaseMs * attempt);
  }
}

/** Collect every matching review into an array. Convenience over the stream. */
export async function getAppleReviews(
  opts: ScrapeOptions,
): Promise<AppleReview[]> {
  const out: AppleReview[] = [];
  for await (const review of streamAppleReviews(opts)) out.push(review);
  return out;
}
