/**
 * Deterministic stand-in for the zalytix API, used by the Playwright suite.
 * Speaks the exact wire contract (see packages/core/src/types.ts) on the dev
 * API's default port so the exported bundle needs no rebuild. Job lifecycle is
 * scripted: poll 1 → waiting, polls 2-3 → active (with progress), poll 4+ → terminal.
 *
 * Magic app ids:
 *   com.e2e.fail   — job ends in `failed`
 *   com.e2e.reject — submit is rejected with a 400
 */

const PORT = Number(process.env.MOCK_API_PORT ?? 3000);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const APP_INFO = {
  store: "google",
  appId: "com.spotify.music",
  country: "us",
  name: "Spotify: Music and Podcasts",
  developer: "Spotify AB",
  category: "Music & Audio",
  description: "Play your favorites.",
  averageRating: 4.4,
  ratingCount: 32_000_000,
  price: 0,
  currency: "USD",
  version: "9.0.0",
  contentRating: "Teen",
  operatingSystem: "Android",
  icon: null,
  url: "https://play.google.com/store/apps/details?id=com.spotify.music",
  histogram: [3_714_863, 1_083_164, 1_331_088, 3_061_651, 26_692_025],
  installs: 3_032_313_142,
  installsText: "1,000,000,000+",
  released: "2014-05-27T13:12:17.000Z",
  updated: "2026-07-06T08:30:56.000Z",
  versionHistory: null,
};

const REVIEWS = [
  {
    store: "google",
    id: "r1",
    userName: "Ada",
    avatar: "https://play-lh.googleusercontent.com/a-/sample-avatar",
    title: "",
    body: "Love the playlists, hate the shuffle. Five stars anyway.",
    rating: 5,
    date: "2026-06-01T10:00:00Z",
    developerResponse: null,
    thumbsUp: 42,
    appVersion: "9.0.0",
    appId: "com.spotify.music",
    country: "us",
  },
  {
    store: "google",
    id: "r2",
    userName: "Linus",
    title: "",
    body: "Crashes on my tablet since the last update.",
    rating: 2,
    date: "2026-05-28T09:30:00Z",
    developerResponse: {
      body: "Thanks for the report — fixed in 9.0.1!",
      modified: "2026-05-29T12:00:00Z",
    },
    thumbsUp: 7,
    appVersion: "9.0.0",
    appId: "com.spotify.music",
    country: "us",
  },
  {
    store: "google",
    id: "r3",
    userName: "Grace",
    title: "",
    body: 'Solid app, "offline mode" is great on flights.',
    rating: 4,
    date: "2026-05-20T18:45:00Z",
    developerResponse: null,
    thumbsUp: 3,
    appVersion: "8.9.2",
    appId: "com.spotify.music",
    country: "us",
  },
];

interface Job {
  appId: string;
  polls: number;
}

const jobs = new Map<string, Job>();
let jobCounter = 0;

Bun.serve({
  port: PORT,
  fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/health") {
      return json({ status: "ok" });
    }

    if (url.pathname === "/app") {
      const appId = url.searchParams.get("appId") ?? "";
      return json({
        store: "google",
        appId,
        country: url.searchParams.get("country") ?? "us",
        appInfo: { ...APP_INFO, appId },
      });
    }

    if (url.pathname === "/reviews/jobs" && request.method === "POST") {
      return request.json().then((body: { appId?: string }) => {
        if (body.appId === "com.e2e.reject") {
          return json({ error: "That app id was rejected by the store." }, 400);
        }
        const id = `e2e-job-${++jobCounter}`;
        jobs.set(id, { appId: body.appId ?? "", polls: 0 });
        return json({ id, status: "waiting" }, 202);
      });
    }

    const jobMatch = url.pathname.match(/^\/reviews\/jobs\/(.+)$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        return json({ error: "Job not found" }, 404);
      }
      job.polls++;
      if (job.polls === 1) {
        return json({ id: jobMatch[1], status: "waiting" });
      }
      if (job.polls === 2) {
        return json({
          id: jobMatch[1],
          status: "active",
          progress: { collected: 42, limit: 100 },
        });
      }
      if (job.polls === 3) {
        return json({
          id: jobMatch[1],
          status: "active",
          progress: { collected: 87, limit: 100 },
        });
      }
      if (job.appId === "com.e2e.fail") {
        return json({
          id: jobMatch[1],
          status: "failed",
          error: "The store blocked this scrape.",
        });
      }
      return json({
        id: jobMatch[1],
        status: "completed",
        result: {
          store: "google",
          appId: job.appId,
          country: "us",
          count: REVIEWS.length,
          partial: false,
          reviews: REVIEWS.map((review) => ({ ...review, appId: job.appId })),
          appInfo: { ...APP_INFO, appId: job.appId },
        },
      });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`mock zalytix API listening on http://localhost:${PORT}`);
