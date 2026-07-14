import type { Review, ScrapeResult } from "@zalytix/core";

/**
 * Deterministic sample scrape for the landing-page showcase — the same
 * seeded-RNG trick as the reference's mock-data, so the real dashboard
 * components can render a rich, stable preview. Clearly labeled as a sample
 * in the UI; never mixed with real results.
 */

function mulberry32(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const AUTHORS = [
  "Maya Chen",
  "Jonas Weber",
  "Aria Novak",
  "Leo Martins",
  "Sofia Rossi",
  "Elias Berg",
  "Nina Kovacs",
  "Owen Brooks",
  "Lucia Ferrer",
  "Tom Bakker",
  "Ida Lund",
  "Ravi Patel",
  "Emma Wright",
  "Noah Kim",
  "Zoe Laurent",
];

const POSITIVE = [
  "The sleep tracking is spot on and the interface feels effortless.",
  "Best focus timer I've used — the insights genuinely changed my routine.",
  "Beautiful design, syncing works perfectly across my devices.",
  "The weekly report is fantastic. Worth every cent of premium.",
  "Notifications are smart, never annoying. Love the widgets too.",
];
const NEUTRAL = [
  "Solid app overall, though the onboarding took longer than expected.",
  "Does what it says. Would like more export options in a future update.",
  "Good tracking but the widgets could use more customization.",
];
const NEGATIVE = [
  "Keeps crashing on startup since the update. Please fix the sync bug.",
  "Battery drain got noticeably worse and the alarm missed twice.",
  "Subscription pricing changed without notice — crashing on my tablet too.",
];

const VERSIONS = ["4.2.1", "4.2.0", "4.1.3", "4.1.0", "4.0.2"];

function buildReviews(): Review[] {
  const rand = mulberry32(20_260_706);
  const now = Date.now();
  const reviews: Review[] = [];
  for (let i = 0; i < 180; i++) {
    const r = rand();
    const rating = r < 0.58 ? 5 : r < 0.76 ? 4 : r < 0.84 ? 3 : r < 0.93 ? 2 : 1;
    const body =
      rating >= 4
        ? POSITIVE[Math.floor(rand() * POSITIVE.length)]
        : rating === 3
          ? NEUTRAL[Math.floor(rand() * NEUTRAL.length)]
          : NEGATIVE[Math.floor(rand() * NEGATIVE.length)];
    // Spread over ~11 months, denser recently; business-hours weighted.
    const daysAgo = Math.floor(rand() ** 1.6 * 330);
    const hour = 8 + Math.floor(rand() * 14);
    const date = new Date(now - daysAgo * 86_400_000);
    date.setHours(hour, Math.floor(rand() * 60), 0, 0);
    const responded = rating <= 3 && rand() < 0.55;
    reviews.push({
      store: "google",
      id: `sample-${i}`,
      userName: AUTHORS[Math.floor(rand() * AUTHORS.length)],
      title: "",
      body,
      rating,
      date: date.toISOString(),
      developerResponse: responded
        ? {
            body: "Thanks for the report — this is fixed in the latest release. Reach out to support@lumen.app if it persists!",
            modified: new Date(date.getTime() + 2 * 86_400_000).toISOString(),
          }
        : null,
      thumbsUp: Math.floor(rand() ** 2 * 90),
      appVersion: VERSIONS[Math.min(Math.floor((daysAgo / 330) * VERSIONS.length), 4)],
      appId: "app.lumen.sleep",
      country: "us",
    });
  }
  return reviews;
}

let cached: ScrapeResult | null = null;

/** The showcase dataset (memoized — built once per session). */
export function sampleResult(): ScrapeResult {
  if (cached) {
    return cached;
  }
  const reviews = buildReviews();
  cached = {
    store: "google",
    appId: "app.lumen.sleep",
    country: "us",
    count: reviews.length,
    partial: false,
    reviews,
    appInfo: {
      store: "google",
      appId: "app.lumen.sleep",
      country: "us",
      name: "Lumen — Sleep & Focus",
      developer: "Brightloop Labs",
      category: "Health & Fitness",
      description: null,
      averageRating: 4.4,
      ratingCount: 128_400,
      price: 0,
      currency: "USD",
      version: "4.2.1",
      contentRating: "Everyone",
      operatingSystem: "Android",
      icon: null,
      url: null,
      histogram: [7300, 4100, 9800, 26_400, 80_800],
      installs: 5_412_338,
      installsText: "5,000,000+",
      released: "2023-03-14T00:00:00.000Z",
      updated: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      versionHistory: null,
    },
  };
  return cached;
}
