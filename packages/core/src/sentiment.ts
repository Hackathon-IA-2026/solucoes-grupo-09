/**
 * Lightweight lexicon sentiment scoring (AFINN-style), tuned for app-review
 * vocabulary. Pure, dependency-free, fast enough to run over thousands of
 * reviews client-side. This is a *signal*, not a model — the classifier
 * blends it with the star rating and the UI labels it accordingly.
 */

const LEXICON: Record<string, number> = {
  // strong positive
  amazing: 4,
  awesome: 4,
  excellent: 4,
  fantastic: 4,
  incredible: 4,
  perfect: 4,
  outstanding: 4,
  superb: 4,
  flawless: 4,
  love: 3,
  loved: 3,
  loves: 3,
  best: 3,
  brilliant: 3,
  beautiful: 3,
  delightful: 3,
  wonderful: 3,
  great: 3,
  // mild positive
  good: 2,
  nice: 2,
  helpful: 2,
  useful: 2,
  smooth: 2,
  fast: 2,
  easy: 2,
  intuitive: 2,
  reliable: 2,
  solid: 2,
  clean: 2,
  works: 1,
  worth: 1,
  happy: 2,
  recommend: 3,
  recommended: 3,
  improved: 2,
  stable: 2,
  enjoy: 2,
  enjoyable: 2,
  free: 1,
  simple: 1,
  fun: 2,
  handy: 2,
  seamless: 3,
  polished: 2,
  // mild negative
  slow: -2,
  laggy: -2,
  lag: -2,
  lags: -2,
  confusing: -2,
  cluttered: -2,
  annoying: -2,
  ads: -1,
  expensive: -2,
  pricey: -2,
  mediocre: -2,
  meh: -2,
  buggy: -3,
  bug: -2,
  bugs: -2,
  glitch: -2,
  glitchy: -3,
  glitches: -2,
  outdated: -2,
  bloated: -2,
  intrusive: -2,
  spam: -3,
  clunky: -2,
  // strong negative
  crash: -3,
  crashes: -3,
  crashing: -3,
  crashed: -3,
  freeze: -3,
  freezes: -3,
  frozen: -3,
  broken: -3,
  unusable: -4,
  terrible: -4,
  horrible: -4,
  awful: -4,
  worst: -4,
  useless: -4,
  garbage: -4,
  trash: -4,
  scam: -5,
  fraud: -5,
  disappointing: -3,
  disappointed: -3,
  hate: -3,
  hated: -3,
  refund: -3,
  uninstall: -3,
  uninstalled: -3,
  uninstalling: -3,
  unreliable: -3,
  fails: -3,
  fail: -2,
  failed: -2,
  error: -2,
  errors: -2,
  stuck: -2,
  drains: -2,
  drain: -2,
};

const NEGATORS = new Set([
  "not",
  "no",
  "never",
  "hardly",
  "barely",
  "isnt",
  "dont",
  "doesnt",
  "didnt",
  "cant",
  "wont",
  "couldnt",
  "wouldnt",
]);
const INTENSIFIERS = new Set([
  "very",
  "really",
  "extremely",
  "super",
  "totally",
  "absolutely",
  "so",
]);

/**
 * Score text in [-1, 1]. 0 means "no signal" (no lexicon hits) — callers must
 * treat that as unknown, not neutral. Handles simple negation ("not good")
 * and intensifiers ("really slow").
 */
export function sentimentScore(text: string): number {
  const words = text
    .toLowerCase()
    .replace(/[''`]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (words.length === 0) return 0;

  let total = 0;
  let hits = 0;
  for (let i = 0; i < words.length; i++) {
    const base = LEXICON[words[i]];
    if (base === undefined) continue;
    let score = base;
    const prev = words[i - 1];
    const prev2 = words[i - 2];
    if (prev && INTENSIFIERS.has(prev)) score *= 1.5;
    if ((prev && NEGATORS.has(prev)) || (prev2 && NEGATORS.has(prev2)))
      score = -score * 0.8;
    total += score;
    hits++;
  }
  if (hits === 0) return 0;
  // Normalize: average word score mapped into [-1, 1] (±4 is the scale cap).
  return Math.max(-1, Math.min(1, total / hits / 4));
}

export type SentimentTone = "positive" | "neutral" | "negative";

/**
 * Classify one review by blending the text signal with the star rating.
 * The text can override the rating only when it speaks clearly (|score| ≥
 * 0.25 with ≥ 4 words); otherwise the rating decides — a 1★ "ok" is negative.
 */
export function classifySentiment(review: {
  body: string;
  rating: number;
}): SentimentTone {
  const score = sentimentScore(review.body);
  const wordCount = review.body.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 4 && Math.abs(score) >= 0.25) {
    return score > 0 ? "positive" : "negative";
  }
  if (review.rating >= 4) return "positive";
  if (review.rating === 3 && score !== 0) return score > 0 ? "positive" : "negative";
  if (review.rating === 3) return "neutral";
  return review.rating >= 1 ? "negative" : "neutral";
}
