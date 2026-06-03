import { pageFetch } from "./browser.js";
import type { FetchResult, StoreAdapter } from "./engine.js";
import type { Review, ReviewSort, ScrapeOptions } from "./types.js";

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
 */
export function parseBatch(body: string): { rows: unknown[]; token: string | null } {
  const stripped = body.replace(/^\)\]\}'/, "");
  const line = stripped.split("\n").find((l) => l.startsWith('[["wrb.fr"'));
  if (!line) return { rows: [], token: null };
  const frame = JSON.parse(line).find((e: unknown[]) => e[1] === REVIEWS_RPC);
  if (!frame?.[2]) return { rows: [], token: null };
  const data = JSON.parse(frame[2]);
  return { rows: data[0] ?? [], token: data[1]?.[1] ?? null };
}

function isoFromSeconds(seconds: unknown): string {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
}

export function normalizeGoogleReview(r: unknown, opts: ScrapeOptions): Review | null {
  if (!Array.isArray(r) || r[0] == null) return null;
  const reply = r[7];
  return {
    store: "google",
    id: String(r[0]),
    userName: r[1]?.[0] ?? "",
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

export const googleAdapter: StoreAdapter<Cursor> = {
  store: "google",
  initialCursor: { token: null },
  landingUrl: (opts) =>
    `${PLAY}/store/apps/details?id=${opts.appId}` +
    `&hl=${opts.lang ?? "en"}&gl=${(opts.country ?? "us").toLowerCase()}`,

  async fetchBatch(page, opts, cursor): Promise<FetchResult<Cursor>> {
    const { status, body } = await pageFetch(page, batchUrl(opts), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: buildBody(opts, cursor.token),
    });
    if (status === 429) return { kind: "rateLimited" };
    if (status !== 200) {
      throw new Error(`batchexecute returned HTTP ${status}: ${body.slice(0, 200)}`);
    }

    const { rows, token } = parseBatch(body);
    if (rows.length === 0) return { kind: "end" };

    const reviews = rows
      .map((r) => normalizeGoogleReview(r, opts))
      .filter((r): r is Review => r !== null);
    return { kind: "page", reviews, next: token ? { token } : null };
  },
};
