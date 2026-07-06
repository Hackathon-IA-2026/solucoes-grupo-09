// Deterministic pseudo-random "scraper" so each pasted URL yields stable, realistic data.

export type Store = "app-store" | "google-play";

export interface Review {
  id: string;
  author: string;
  avatar: string;
  rating: number;
  date: string;
  daysAgo: number;
  title: string;
  body: string;
  helpful: number;
  version: string;
  country: string;
  sentiment: "positive" | "neutral" | "negative";
  developerResponse?: {
    date: string;
    body: string;
  };
}

export interface ScrapeResult {
  store: Store;
  appName: string;
  developer: string;
  category: string;
  icon: string; // emoji-free: a color seed
  iconHue: number;
  rating: number;
  ratingChange: number;
  totalReviews: number;
  totalScraped: number;
  responseRate: number;
  distribution: number[]; // [1star,2,3,4,5]
  sentiment: { positive: number; neutral: number; negative: number };
  timeline: { month: string; avg: number; count: number }[];
  keywords: { word: string; count: number; tone: "positive" | "negative" | "neutral" }[];
  versions: { version: string; rating: number; reviews: number }[];
  reviews: Review[];
}

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const APP_NAMES = [
  "Lumen",
  "Northwind",
  "Cadence",
  "Pixelforge",
  "Halcyon",
  "Verge",
  "Nimbus",
  "Orbit",
  "Ember",
  "Slate",
  "Tidal",
  "Zephyr",
];
const DEVELOPERS = [
  "Brightloop Labs",
  "Northwind Studios",
  "Cadence Inc.",
  "Pixelforge Co.",
  "Halcyon Digital",
  "Verge Software",
];
const CATEGORIES = [
  "Productivity",
  "Finance",
  "Health & Fitness",
  "Photo & Video",
  "Social",
  "Music",
];
const COUNTRIES = ["US", "GB", "DE", "IN", "BR", "JP", "CA", "AU", "FR", "MX"];
const FIRST = [
  "Theresa",
  "Robert",
  "Darlene",
  "Jerome",
  "Kristin",
  "Cody",
  "Arlene",
  "Devon",
  "Marvin",
  "Colleen",
  "Wade",
  "Esther",
  "Guy",
  "Jenny",
  "Cameron",
];
const LAST = [
  "Webb",
  "Fox",
  "Robertson",
  "Bell",
  "Watson",
  "Fisher",
  "McCoy",
  "Lane",
  "Nguyen",
  "Cooper",
  "Warren",
  "Howard",
  "Hawkins",
  "Wilson",
];

const POS_TITLES = [
  "Absolute game changer",
  "Best in class",
  "Can't live without it",
  "Beautifully done",
  "Finally, it just works",
  "Worth every penny",
  "Impressive update",
];
const NEG_TITLES = [
  "Constant crashes",
  "Went downhill fast",
  "Latest update broke it",
  "Too many ads now",
  "Login never works",
  "Battery drain nightmare",
  "Disappointed after update",
];
const NEU_TITLES = [
  "Good but needs work",
  "Decent, with caveats",
  "Mixed feelings",
  "Almost there",
  "Solid start",
];

const POS_BODIES = [
  "The new dashboard is incredibly smooth and the sync is instant across all my devices. Support replied within an hour.",
  "I've tried every competitor and nothing comes close to this level of polish. The onboarding was effortless.",
  "Performance is night and day after the redesign. Everything feels snappy and thoughtful.",
  "Exactly what I needed for daily work. Clean interface, no bloat, and the widgets are fantastic.",
];
const NEG_BODIES = [
  "Ever since the last update the app crashes on launch. I've reinstalled twice with no luck. Please fix ASAP.",
  "The subscription price doubled and half the features are now behind a paywall. Feels like a bait and switch.",
  "Constant sync errors and my data disappeared overnight. Lost hours of work. Really frustrating experience.",
  "Way too many intrusive ads after the free trial ended. It makes the app almost unusable now.",
];
const NEU_BODIES = [
  "Core features are solid but the notifications are unreliable and settings are hard to find.",
  "It does what it says, though the UI could use some love. Looking forward to future updates.",
  "Good value overall. Wish it had offline mode and better export options.",
];

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function detectStore(url: string): Store {
  const u = url.toLowerCase();
  if (u.includes("play.google") || u.includes("google")) return "google-play";
  return "app-store";
}

export function scrape(url: string): ScrapeResult {
  const seed = hashString(url.trim().toLowerCase() || "noviq");
  const rng = mulberry32(seed);
  const store = detectStore(url);

  const appName = pick(rng, APP_NAMES);
  const developer = pick(rng, DEVELOPERS);
  const category = pick(rng, CATEGORIES);
  const iconHue = Math.floor(rng() * 360);

  // distribution skewed toward 4-5 stars but with variance
  const base5 = 40 + rng() * 35;
  const base4 = 18 + rng() * 15;
  const base3 = 6 + rng() * 8;
  const base2 = 3 + rng() * 6;
  const base1 = 5 + rng() * 18;
  const rawDist = [base1, base2, base3, base4, base5];
  const distSum = rawDist.reduce((a, b) => a + b, 0);
  const distribution = rawDist.map((v) => Math.round((v / distSum) * 1000) / 10);

  const totalReviews = Math.floor(8000 + rng() * 980000);
  const totalScraped = Math.floor(totalReviews * (0.6 + rng() * 0.35));

  const rating =
    Math.round(
      ((distribution[0] * 1 +
        distribution[1] * 2 +
        distribution[2] * 3 +
        distribution[3] * 4 +
        distribution[4] * 5) /
        100) *
        10,
    ) / 10;

  const ratingChange = Math.round((rng() * 0.8 - 0.35) * 100) / 100;
  const responseRate = Math.floor(20 + rng() * 70);

  const posShare = distribution[3] + distribution[4];
  const negShare = distribution[0] + distribution[1];
  const neuShare = distribution[2];
  const sTotal = posShare + negShare + neuShare;
  const sentiment = {
    positive: Math.round((posShare / sTotal) * 100),
    neutral: Math.round((neuShare / sTotal) * 100),
    negative: Math.round((negShare / sTotal) * 100),
  };

  const months = [
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
  ];
  const timeline = months.map((m) => {
    const avg = Math.max(2.4, Math.min(4.9, rating + (rng() - 0.5) * 1.2));
    return {
      month: m,
      avg: Math.round(avg * 10) / 10,
      count: Math.floor(300 + rng() * 4200),
    };
  });

  const KW_POS = [
    "intuitive",
    "fast",
    "beautiful",
    "reliable",
    "worth it",
    "smooth",
    "helpful",
  ];
  const KW_NEG = ["crashes", "expensive", "ads", "bugs", "login", "slow", "paywall"];
  const KW_NEU = ["update", "sync", "widget", "export", "offline"];
  const keywords = [
    ...KW_POS.slice(0, 4).map((word) => ({
      word,
      count: Math.floor(120 + rng() * 900),
      tone: "positive" as const,
    })),
    ...KW_NEG.slice(0, 4).map((word) => ({
      word,
      count: Math.floor(80 + rng() * 700),
      tone: "negative" as const,
    })),
    ...KW_NEU.slice(0, 3).map((word) => ({
      word,
      count: Math.floor(60 + rng() * 500),
      tone: "neutral" as const,
    })),
  ].sort((a, b) => b.count - a.count);

  const versions = Array.from({ length: 5 }, (_, i) => {
    const major = 8 - Math.floor(i / 2);
    const minor = (5 - i + 10) % 10;
    return {
      version: `${major}.${minor}.${Math.floor(rng() * 9)}`,
      rating: Math.round(Math.max(2.6, Math.min(4.9, rating + (rng() - 0.5))) * 10) / 10,
      reviews: Math.floor(400 + rng() * 6000),
    };
  });

  const reviews: Review[] = Array.from({ length: 14 }, (_, i) => {
    const roll = rng();
    let stars: number;
    let sentimentTag: Review["sentiment"];
    let title: string;
    let body: string;
    if (roll < posShare / 100) {
      stars = rng() > 0.4 ? 5 : 4;
      sentimentTag = "positive";
      title = pick(rng, POS_TITLES);
      body = pick(rng, POS_BODIES);
    } else if (roll < (posShare + neuShare) / 100) {
      stars = 3;
      sentimentTag = "neutral";
      title = pick(rng, NEU_TITLES);
      body = pick(rng, NEU_BODIES);
    } else {
      stars = rng() > 0.5 ? 1 : 2;
      sentimentTag = "negative";
      title = pick(rng, NEG_TITLES);
      body = pick(rng, NEG_BODIES);
    }
    const daysAgo = Math.floor(rng() * 220) + i;
    const author = `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
    const hasResponse = rng() < responseRate / 100;
    return {
      id: `${seed}-${i}`,
      author,
      avatar: author
        .split(" ")
        .map((n) => n[0])
        .join(""),
      rating: stars,
      date: daysToDate(daysAgo),
      daysAgo,
      title,
      body,
      helpful: Math.floor(rng() * 340),
      version: pick(rng, versions).version,
      country: pick(rng, COUNTRIES),
      sentiment: sentimentTag,
      developerResponse: hasResponse
        ? {
            date: daysToDate(Math.max(0, daysAgo - Math.floor(rng() * 5) - 1)),
            body: "Thanks for the detailed feedback! We've shipped a fix in the latest build — please update and reach out to support@noviq.app if anything's still off.",
          }
        : undefined,
    };
  }).sort((a, b) => a.daysAgo - b.daysAgo);

  return {
    store,
    appName,
    developer,
    category,
    icon: appName[0],
    iconHue,
    rating,
    ratingChange,
    totalReviews,
    totalScraped,
    responseRate,
    distribution,
    sentiment,
    timeline,
    keywords,
    versions,
    reviews,
  };
}

function daysToDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
