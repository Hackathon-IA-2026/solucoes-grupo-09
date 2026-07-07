import type { Page } from "./browser.js";
import { pageFetch } from "./browser.js";
import type { FetchResult, StoreAdapter } from "./engine.js";
import { UpstreamError } from "./errors.js";
import type { AppInfo, Review, ReviewSort, ScrapeOptions } from "./types.js";

const PLAY = "https://play.google.com";
const BATCH_URL = `${PLAY}/_/PlayStoreUi/data/batchexecute`;
const REVIEWS_RPC = "UsvDTd";
const PAGE_SIZE = 100; // reviews per batchexecute call

// Google's numeric sort codes.
const SORT_MAP: Record<ReviewSort, number> = {
  mostHelpful: 1, // HELPFULNESS
  mostRecent: 2, // NEWEST
  rating: 3, // RATING
};

/** Pagination cursor: the continuation token (null on the first request). */
interface Cursor {
  token: string | null;
}

export function buildBody(opts: ScrapeOptions, token: string | null): string {
  const sort = SORT_MAP[opts.sort ?? "mostRecent"];
  // Shape reverse-engineered from the Play Store web app's UsvDTd RPC.
  const inner = JSON.stringify([
    null,
    null,
    [2, sort, [PAGE_SIZE, null, token], null, []],
    [opts.appId, 7],
  ]);
  const freq = JSON.stringify([[[REVIEWS_RPC, inner, null, "generic"]]]);
  return `f.req=${encodeURIComponent(freq)}`;
}

function batchUrl(opts: ScrapeOptions): string {
  const params = new URLSearchParams({
    rpcids: REVIEWS_RPC,
    "source-path": "/store/apps/details",
    hl: opts.lang ?? "en",
    gl: (opts.country ?? "us").toLowerCase(),
    // _reqid varies per request like a real client; randomness is fine here.
    _reqid: String(100000 + Math.floor(Math.random() * 900000)),
    rt: "c",
  });
  return `${BATCH_URL}?${params}`;
}

/**
 * Unwrap a batchexecute response: strip the `)]}'` XSSI guard and the
 * length-prefixed framing, then pull out our RPC's payload. Returns the raw
 * review tuples plus the next continuation token.
 *
 * A 200 from batchexecute MUST carry our RPC's `wrb.fr` frame. If it doesn't
 * (the framing/format changed, or we were soft-blocked behind a 200), that's an
 * upstream failure — we throw rather than return empty, because returning empty
 * is indistinguishable from "the feed ended" and would silently truncate the
 * pull and report it as a clean success. An empty-but-valid frame (genuinely no
 * more reviews) still returns `{ rows: [], token: null }` and ends normally.
 */
export function parseBatch(body: string): { rows: unknown[]; token: string | null } {
  const stripped = body.replace(/^\)\]\}'/, "");
  const line = stripped.split("\n").find((l) => l.startsWith('[["wrb.fr"'));
  if (!line) {
    throw new UpstreamError(
      "Play response missing the reviews frame (format change or block)",
    );
  }
  try {
    const frame = JSON.parse(line).find((e: unknown[]) => e[1] === REVIEWS_RPC);
    if (!frame?.[2]) {
      throw new UpstreamError("Play response carried no reviews payload");
    }
    const data = JSON.parse(frame[2]);
    return { rows: data[0] ?? [], token: data[1]?.[1] ?? null };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError("Could not parse the Play reviews response", { cause: err });
  }
}

function isoFromSeconds(seconds: unknown): string {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
}

export function normalizeGoogleReview(r: unknown, opts: ScrapeOptions): Review | null {
  if (!Array.isArray(r) || r[0] == null) return null;
  const reply = r[7];
  // Reviewer avatar lives at r[1][1][3][2] (verified live 2026-07-06).
  const avatar = r[1]?.[1]?.[3]?.[2];
  return {
    store: "google",
    id: String(r[0]),
    userName: r[1]?.[0] ?? "",
    ...(typeof avatar === "string" && avatar.startsWith("http") ? { avatar } : {}),
    title: "", // Play reviews have no title
    body: r[4] ?? "",
    rating: Number(r[2] ?? 0),
    date: isoFromSeconds(r[5]?.[0]),
    thumbsUp: Number(r[6] ?? 0),
    appVersion: r[10] ?? undefined,
    developerResponse: reply
      ? { body: reply[1] ?? "", modified: isoFromSeconds(reply[2]?.[0]) }
      : null,
    appId: opts.appId,
    country: (opts.country ?? "us").toLowerCase(),
  };
}

/** Pull the raw ds:5 details blob out of the already-loaded landing page. */
export async function readDs5(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const script of Array.from(document.querySelectorAll("script"))) {
      const text = script.textContent ?? "";
      if (text.includes("AF_initDataCallback") && text.includes("'ds:5'")) {
        const start = text.indexOf("data:");
        const end = text.lastIndexOf(", sideChannel");
        if (start >= 0 && end > start) return text.slice(start + 5, end);
      }
    }
    return null;
  });
}

function isoFromUnix(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

/**
 * Parse store-wide extras from the details page's ds:5 blob (paths verified
 * live 2026-07-06 against google-play-scraper's known mappings):
 * - `[1][2][51][1][star][1]` → per-star counts (histogram);
 * - `[1][2][13]`  → installs: [text, minimum, realCount, shortText];
 * - `[1][2][145][0][1][0]` → last-updated unix seconds;
 * - `[1][2][10][1][0]` → released unix seconds.
 * Pure and defensive — any index surprise degrades to missing fields.
 */
export function parseGoogleExtras(ds5raw: string): Partial<AppInfo> {
  let data: unknown;
  try {
    data = JSON.parse(ds5raw);
  } catch {
    return {};
  }
  // biome-ignore lint/suspicious/noExplicitAny: reverse-engineered positional blob
  const root = (data as any)?.[1]?.[2];
  if (!root) return {};
  const extras: Partial<AppInfo> = {};

  const ratings = root[51];
  if (Array.isArray(ratings?.[1])) {
    const counts: number[] = [];
    for (let star = 1; star <= 5; star++) {
      const n = ratings[1][star]?.[1];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) break;
      counts.push(n);
    }
    if (counts.length === 5) extras.histogram = counts;
  }
  if (typeof ratings?.[0]?.[1] === "number") {
    extras.averageRating = Math.round(ratings[0][1] * 100) / 100;
  }
  if (typeof ratings?.[2]?.[1] === "number") extras.ratingCount = ratings[2][1];

  const installs = root[13];
  if (typeof installs?.[2] === "number") extras.installs = installs[2];
  else if (typeof installs?.[1] === "number") extras.installs = installs[1];
  if (typeof installs?.[0] === "string") extras.installsText = installs[0];

  const updated = isoFromUnix(root[145]?.[0]?.[1]?.[0]);
  if (updated) extras.updated = updated;
  const released = isoFromUnix(root[10]?.[1]?.[0]);
  if (released) extras.released = released;

  return extras;
}

export const googleAdapter: StoreAdapter<Cursor> = {
  store: "google",
  initialCursor: { token: null },
  landingUrl: (opts) =>
    `${PLAY}/store/apps/details?id=${opts.appId}` +
    `&hl=${opts.lang ?? "en"}&gl=${(opts.country ?? "us").toLowerCase()}`,

  async fetchAppExtras(page) {
    const raw = await readDs5(page);
    return raw ? parseGoogleExtras(raw) : {};
  },

  async fetchBatch(page, opts, cursor): Promise<FetchResult<Cursor>> {
    const { status, body } = await pageFetch(page, batchUrl(opts), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: buildBody(opts, cursor.token),
    });
    if (status === 429) return { kind: "rateLimited" };
    if (status !== 200) {
      throw new UpstreamError(
        `batchexecute returned HTTP ${status}: ${body.slice(0, 200)}`,
      );
    }

    const { rows, token } = parseBatch(body);
    if (rows.length === 0) return { kind: "end" };

    const reviews = rows
      .map((r) => normalizeGoogleReview(r, opts))
      .filter((r): r is Review => r !== null);
    return { kind: "page", reviews, next: token ? { token } : null };
  },
};
