import { classifySentiment, type Review, type VersionRelease } from "@noviq/core";

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
    const tone = classifySentiment(review);
    if (tone === "positive") positive++;
    else if (tone === "negative") negative++;
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

export interface VersionBreakdown {
  stats: VersionStat[];
  /**
   * True when versions were inferred from release windows (Apple — its
   * review API omits per-review versions) rather than read directly.
   */
  approximate: boolean;
  /** Reviews older than the oldest known release (approximation only). */
  excluded: number;
}

/**
 * Avg rating per app version. Google reviews carry `appVersion` directly;
 * for Apple we approximate by bucketing review dates into the release
 * windows from `versionHistory` (newest-first) and label it as such.
 */
export function versionStats(
  reviews: Review[],
  history?: VersionRelease[] | null,
  top = 5,
): VersionBreakdown {
  const direct = new Map<string, { count: number; sum: number }>();
  for (const review of reviews) {
    if (!review.appVersion) continue;
    const stat = direct.get(review.appVersion) ?? { count: 0, sum: 0 };
    stat.count++;
    stat.sum += review.rating;
    direct.set(review.appVersion, stat);
  }
  if (direct.size > 0) {
    return {
      approximate: false,
      excluded: 0,
      stats: [...direct.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, top)
        .map(([version, s]) => ({ version, rating: s.sum / s.count, reviews: s.count })),
    };
  }

  if (!history || history.length === 0) {
    return { approximate: false, excluded: 0, stats: [] };
  }
  // Release windows: history is newest-first; a review belongs to the newest
  // release published before it. Reviews older than the oldest known release
  // are dropped rather than misattributed.
  const releases = history
    .map((r) => ({ version: r.version, at: new Date(r.released).getTime() }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => b.at - a.at);
  if (releases.length === 0) return { approximate: false, excluded: 0, stats: [] };
  const windows = new Map<string, { count: number; sum: number; at: number }>();
  let excluded = 0;
  for (const review of reviews) {
    const when = new Date(review.date).getTime();
    if (!Number.isFinite(when)) continue;
    const release = releases.find((r) => when >= r.at);
    if (!release) {
      excluded++;
      continue;
    }
    const stat = windows.get(release.version) ?? { count: 0, sum: 0, at: release.at };
    stat.count++;
    stat.sum += review.rating;
    windows.set(release.version, stat);
  }
  return {
    approximate: true,
    excluded,
    stats: [...windows.entries()]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, top)
      .map(([version, s]) => ({ version, rating: s.sum / s.count, reviews: s.count })),
  };
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

/** Blended (text + rating) sentiment for one review. */
export function reviewTone(review: Review): "positive" | "neutral" | "negative" {
  return classifySentiment(review);
}

export interface HeatmapData {
  /** 7 row labels (clock hours, descending like the reference). */
  hours: string[];
  /** Sun..Sat column labels. */
  days: string[];
  /** [row][col] intensity 0–4. */
  levels: number[][];
  /** Ascending legend labels for levels 1–4. */
  legend: string[];
}

export const HEATMAP_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourLabel(hour: number): string {
  const h = ((hour + 11) % 12) + 1;
  return `${h}${hour < 12 ? "am" : "pm"}`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

/**
 * "When reviews land": real review timestamps bucketed by hour-of-day ×
 * weekday. The 7 busiest hours become rows (descending clock order, like the
 * reference's 2pm→8am). `dim`:
 * - reviews: cell intensity = review count, thresholds from count quantiles;
 * - ratings: cell intensity = average star rating in fixed bands.
 */
export function heatmap(
  reviews: Review[],
  dim: "reviews" | "ratings" = "reviews",
): HeatmapData | null {
  const counts = Array.from({ length: 24 }, () => new Array<number>(7).fill(0));
  const sums = Array.from({ length: 24 }, () => new Array<number>(7).fill(0));
  let valid = 0;
  for (const review of reviews) {
    const date = new Date(review.date);
    if (Number.isNaN(date.getTime())) continue;
    counts[date.getHours()][date.getDay()]++;
    sums[date.getHours()][date.getDay()] += review.rating;
    valid++;
  }
  if (valid === 0) return null;

  const hourTotals = counts.map((row, hour) => ({
    hour,
    total: row.reduce((a, b) => a + b, 0),
  }));
  const topHours = hourTotals
    .filter((h) => h.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 7)
    .map((h) => h.hour)
    .sort((a, b) => b - a);
  while (topHours.length < 7) {
    // Pad sparse datasets with quiet hours so the grid stays 7×7.
    const missing = hourTotals.find((h) => !topHours.includes(h.hour) && h.total === 0);
    if (!missing) break;
    topHours.push(missing.hour);
    topHours.sort((a, b) => b - a);
  }

  if (dim === "ratings") {
    const bands = [3, 3.75, 4.25, 4.6];
    return {
      hours: topHours.map(hourLabel),
      days: HEATMAP_DAYS,
      levels: topHours.map((hour) =>
        HEATMAP_DAYS.map((_, day) => {
          const n = counts[hour][day];
          if (n === 0) return 0;
          const avg = sums[hour][day] / n;
          if (avg >= bands[3]) return 4;
          if (avg >= bands[2]) return 3;
          if (avg >= bands[1]) return 2;
          return 1;
        }),
      ),
      legend: ["<3.0★", "≥3.0★", "≥4.3★", "≥4.6★"],
    };
  }

  const nonzero = topHours
    .flatMap((hour) => counts[hour])
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const t2 = Math.max(2, quantile(nonzero, 0.5));
  const t3 = Math.max(t2 + 1, quantile(nonzero, 0.75));
  const t4 = Math.max(t3 + 1, quantile(nonzero, 0.9));
  return {
    hours: topHours.map(hourLabel),
    days: HEATMAP_DAYS,
    levels: topHours.map((hour) =>
      HEATMAP_DAYS.map((_, day) => {
        const n = counts[hour][day];
        if (n === 0) return 0;
        if (n >= t4) return 4;
        if (n >= t3) return 3;
        if (n >= t2) return 2;
        return 1;
      }),
    ),
    legend: ["≥1", `≥${t2}`, `≥${t3}`, `≥${t4}`],
  };
}
