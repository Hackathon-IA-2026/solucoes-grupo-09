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
  bad: -3,
  poor: -3,
  worse: -3,
  sucks: -3,
  suck: -3,
  ok: 0.5,
  okay: 0.5,
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
interface SentimentAnalysis {
  /** Normalized score in [-1, 1]; 0 with hits=0 means "no signal". */
  score: number;
  /** Number of lexicon words that contributed. */
  hits: number;
}

/**
 * Analyze text: clause-aware so negation never leaks across sentence or
 * comma boundaries ("Not bad. Crashes sometimes." must not read "not
 * crashes"). Handles both ASCII and typographic apostrophes — iOS keyboards
 * emit U+2019, and "can\u2019t" must still match the negator "cant".
 */
export function analyzeSentiment(text: string): SentimentAnalysis {
  let total = 0;
  let hits = 0;
  // Split into clauses first; negation/intensity windows stay inside one.
  for (const clause of text.split(/[.!?,;:\n()]+/)) {
    const words = clause
      .toLowerCase()
      .replace(/['\u2018\u2019`]/g, "")
      .split(/[^a-z]+/)
      .filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const base = LEXICON[words[i]];
      if (base === undefined) continue;
      let score = base;
      const prev = words[i - 1];
      const prev2 = words[i - 2];
      if (prev && INTENSIFIERS.has(prev)) score *= 1.5;
      if ((prev && NEGATORS.has(prev)) || (prev2 && NEGATORS.has(prev2))) {
        score = -score * 0.8;
      }
      total += score;
      hits++;
    }
  }
  if (hits === 0) return { score: 0, hits: 0 };
  // Normalize: average word score mapped into [-1, 1] (±4 is the scale cap).
  return { score: Math.max(-1, Math.min(1, total / hits / 4)), hits };
}

/** Score text in [-1, 1]. 0 means "no signal" (no lexicon hits). */
export function sentimentScore(text: string): number {
  return analyzeSentiment(text).score;
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
  const { score, hits } = analyzeSentiment(review.body);
  // The text overrides a clear star rating only when it speaks loudly AND
  // repeatedly (≥2 lexicon hits, strong score, in the opposite direction) —
  // one incidental "crashes" in a happy 5★ review must not flip it.
  if (review.rating >= 4) {
    return hits >= 2 && score <= -0.35 ? "negative" : "positive";
  }
  if (review.rating <= 2 && review.rating >= 1) {
    return hits >= 2 && score >= 0.35 ? "positive" : "negative";
  }
  // 3★ (or unrated): any clear text signal decides; otherwise neutral.
  if (hits > 0 && Math.abs(score) >= 0.1) return score > 0 ? "positive" : "negative";
  return "neutral";
}
