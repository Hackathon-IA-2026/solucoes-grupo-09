import type { Review } from "./types";

/** Compact human numbers: 950 → "950", 1400 → "1.4K", 2_100_000 → "2.1M". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs < 1_000) return String(value);
  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      // One decimal below 10 ("1.4K"), none above ("14K") — Tufte-tight.
      const text = Math.abs(scaled) < 10 ? scaled.toFixed(1) : String(Math.round(scaled));
      return `${text.replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(value);
}

/** "4.6" style star rating (one decimal, no trailing zero surprises). */
export function formatRating(rating: number): string {
  return (Math.round(rating * 10) / 10).toFixed(1);
}

/** ISO date → "Mar 4, 2026" (falls back to the raw string on bad input). */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Histogram of ratings 1..5 → counts, for distribution bars. */
export function ratingDistribution(reviews: Review[]): Record<1 | 2 | 3 | 4 | 5, number> {
  const dist: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const review of reviews) {
    const stars = Math.round(review.rating);
    if (stars >= 1 && stars <= 5) dist[stars as 1 | 2 | 3 | 4 | 5] += 1;
  }
  return dist;
}

/** Mean rating of the scraped set (0 when empty or all ratings missing). */
export function averageRating(reviews: Review[]): number {
  const rated = reviews.filter((review) => review.rating > 0);
  if (rated.length === 0) return 0;
  const sum = rated.reduce((total, review) => total + review.rating, 0);
  return Math.round((sum / rated.length) * 100) / 100;
}
