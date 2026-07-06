import type { Review } from "@noviq/core";

/**
 * Dashboard analytics computed from the actually-scraped reviews — the
 * reference app fakes these from a seeded RNG; we derive them for real.
 * Sentiment is a rating proxy (4-5 positive, 3 neutral, 1-2 negative),
 * honestly labeled in the UI.
 */

export interface SentimentMix {
  positive: number;
  neutral: number;
  negative: number;
}

export interface TimelinePoint {
  month: string;
  count: number;
  avg: number;
}

export interface KeywordStat {
  word: string;
  count: number;
  tone: "positive" | "neutral" | "negative";
}

export interface VersionStat {
  version: string;
  rating: number;
  reviews: number;
}

export function sentimentMix(reviews: Review[]): SentimentMix {
  if (reviews.length === 0) return { positive: 0, neutral: 0, negative: 0 };
  let positive = 0;
  let negative = 0;
  for (const review of reviews) {
    if (review.rating >= 4) positive++;
    else if (review.rating < 3) negative++;
  }
  const pct = (n: number) => Math.round((n / reviews.length) * 100);
  const p = pct(positive);
  const n = pct(negative);
  // Make the three segments sum to exactly 100 for the ring.
  return { positive: p, negative: n, neutral: Math.max(0, 100 - p - n) };
}

/** % of 1..5 star reviews, index 0 = 1★ (reference `distribution`). */
export function distributionPct(reviews: Review[]): number[] {
  const counts = [0, 0, 0, 0, 0];
  let rated = 0;
  for (const review of reviews) {
    const star = Math.round(review.rating);
    if (star >= 1 && star <= 5) {
      counts[star - 1]++;
      rated++;
    }
  }
  if (rated === 0) return counts;
  return counts.map((c) => (c / rated) * 100);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Review volume + avg rating per month, oldest → newest (max 12 buckets). */
export function timeline(reviews: Review[]): TimelinePoint[] {
  const buckets = new Map<string, { count: number; sum: number; when: number }>();
  for (const review of reviews) {
    const date = new Date(review.date);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    const bucket = buckets.get(key) ?? {
      count: 0,
      sum: 0,
      when: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
    };
    bucket.count++;
    bucket.sum += review.rating;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => a.when - b.when)
    .slice(-12)
    .map((bucket) => ({
      month: MONTHS[new Date(bucket.when).getMonth()],
      count: bucket.count,
      avg: bucket.count ? bucket.sum / bucket.count : 0,
    }));
}

const STOPWORDS = new Set(
  "the a an and or but if then this that these those is are was were be been being have has had do does did i you he she it we they me him her them my your its our their of in on at to for with from as by not no so too very just really only also can could would should will won't don't doesn't didn't isn't its it's i'm i've im ive u ur get got one all out up down about after before more most much many some any even still than when what who how why there here app apps use using used love like good great nice best"
    .split(" ")
    .filter(Boolean),
);

/** Top mentioned words with a tone from the avg rating of containing reviews. */
export function keywords(reviews: Review[], top = 10): KeywordStat[] {
  const stats = new Map<string, { count: number; sum: number }>();
  for (const review of reviews) {
    const seen = new Set<string>();
    for (const raw of review.body.toLowerCase().split(/[^a-z']+/)) {
      const word = raw.replace(/^'+|'+$/g, "");
      if (word.length < 4 || STOPWORDS.has(word) || seen.has(word)) continue;
      seen.add(word);
      const stat = stats.get(word) ?? { count: 0, sum: 0 };
      stat.count++;
      stat.sum += review.rating;
      stats.set(word, stat);
    }
  }
  return [...stats.entries()]
    .filter(([, s]) => s.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, top)
    .map(([word, s]) => {
      const avg = s.sum / s.count;
      return {
        word,
        count: s.count,
        tone: avg >= 3.6 ? "positive" : avg <= 2.6 ? "negative" : "neutral",
      } as KeywordStat;
    });
}

/** Avg rating per app version (Google reviews carry versions), most-reviewed first. */
export function versionStats(reviews: Review[], top = 5): VersionStat[] {
  const stats = new Map<string, { count: number; sum: number }>();
  for (const review of reviews) {
    if (!review.appVersion) continue;
    const stat = stats.get(review.appVersion) ?? { count: 0, sum: 0 };
    stat.count++;
    stat.sum += review.rating;
    stats.set(review.appVersion, stat);
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, top)
    .map(([version, s]) => ({
      version,
      rating: s.sum / s.count,
      reviews: s.count,
    }));
}

/** % of reviews with a developer response. */
export function responseRate(reviews: Review[]): number {
  if (reviews.length === 0) return 0;
  const responded = reviews.filter((r) => r.developerResponse).length;
  return Math.round((responded / reviews.length) * 100);
}

/** Initials for the avatar circle ("Jane D." → "JD"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Rating-proxy sentiment for one review. */
export function reviewTone(review: Review): "positive" | "neutral" | "negative" {
  if (review.rating >= 4) return "positive";
  if (review.rating === 3) return "neutral";
  return "negative";
}
