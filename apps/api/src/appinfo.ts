import type { AppInfo, Store } from "./types.js";

/**
 * Parses app-level metadata out of the schema.org JSON-LD that App Store and
 * Google Play both embed in their landing pages (a `<script type=
 * "application/ld+json">` describing a `SoftwareApplication`). Using this
 * standard format — rather than each store's reverse-engineered internals —
 * means one parser serves both stores and stays stable across layout changes.
 *
 * Everything here is pure and defensive: unknown shapes, missing fields and
 * junk scripts degrade to `null` instead of throwing, so a metadata miss can
 * never fail a scrape.
 */

/** Provenance attached to the parsed metadata (the parser can't infer it). */
interface Provenance {
  store: Store;
  appId: string;
  country: string;
}

// schema.org types that represent an app. `@type` is sometimes an array or an
// unexpected value, so we also fall back to a structural heuristic below.
const APP_TYPE = /(?:Software|Mobile|Web)Application|VideoGame/i;

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (Array.isArray(t)) {
    return t.map(String);
  }
  return t == null ? [] : [String(t)];
}

/** Is this node an app? By `@type`, or structurally (named + app-ish fields). */
function isAppNode(node: Record<string, unknown>): boolean {
  if (typesOf(node).some((t) => APP_TYPE.test(t))) {
    return true;
  }
  return (
    typeof node.name === "string" &&
    ("applicationCategory" in node ||
      "operatingSystem" in node ||
      "softwareVersion" in node)
  );
}

/** Depth-first search for the app node across objects, arrays and `@graph`. */
function findAppNode(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAppNode(item);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    if (isAppNode(node)) {
      return node;
    }
    if (Array.isArray(node["@graph"])) {
      return findAppNode(node["@graph"]);
    }
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/** First non-empty string from a value that may be a string, array or object. */
function firstStr(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = firstStr(item);
      if (s) {
        return s;
      }
    }
    return null;
  }
  return str(value);
}

function num(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

/** Round to 2 decimals — stores publish high-precision rating floats (e.g.
 * 4.334024…) but only ~1–2 places are meaningful, and it reads cleaner. */
function round2(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

/** A name from a Person/Organization that may be a string, object or array. */
function nameOf(value: unknown): string | null {
  if (typeof value === "string") {
    return str(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const n = nameOf(item);
      if (n) {
        return n;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    return str((value as Record<string, unknown>).name);
  }
  return null;
}

/** An image URL from a string, an ImageObject, or an array of either. */
function imageOf(value: unknown): string | null {
  if (typeof value === "string") {
    return str(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const u = imageOf(item);
      if (u) {
        return u;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return str(obj.url) ?? str(obj.contentUrl);
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const first = value.find((v) => v && typeof v === "object");
    return (first as Record<string, unknown>) ?? null;
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

// The metadata fields (everything but provenance). Used to reject a node that
// matched as an app but carried nothing usable.
const META_KEYS = [
  "name",
  "developer",
  "category",
  "description",
  "averageRating",
  "ratingCount",
  "price",
  "currency",
  "version",
  "contentRating",
  "operatingSystem",
  "icon",
  "url",
] as const;

function hasMetadata(info: AppInfo): boolean {
  return META_KEYS.some((key) => info[key] !== null);
}

function normalize(app: Record<string, unknown>, prov: Provenance): AppInfo {
  const rating = asObject(app.aggregateRating) ?? {};
  const offer = asObject(app.offers) ?? {};
  return {
    store: prov.store,
    appId: prov.appId,
    country: prov.country,
    name: str(app.name),
    developer: nameOf(app.author) ?? nameOf(app.creator) ?? nameOf(app.publisher),
    category: firstStr(app.applicationCategory) ?? firstStr(app.genre),
    description: str(app.description),
    averageRating: round2(rating.ratingValue),
    ratingCount: int(rating.ratingCount) ?? int(rating.reviewCount),
    price: num(offer.price),
    currency: str(offer.priceCurrency),
    version: str(app.softwareVersion) ?? str(app.version),
    contentRating: str(app.contentRating),
    operatingSystem: firstStr(app.operatingSystem),
    icon: imageOf(app.image) ?? imageOf(app.screenshot),
    url: str(app.url) ?? str(app["@id"]),
    // Filled by the store adapters' extras pass (engine merge), not JSON-LD.
    histogram: null,
    installs: null,
    installsText: null,
    released: null,
    updated: null,
    versionHistory: null,
  };
}

/**
 * Parse the first usable `SoftwareApplication` out of a page's JSON-LD scripts.
 * Each entry is the raw text of one `<script type="application/ld+json">`.
 * Returns `null` when no script yields an app node with any usable field (so a
 * bare `{"@type":"SoftwareApplication"}` is treated as "nothing found", not as
 * an all-null record).
 */
export function parseAppInfo(scripts: string[], prov: Provenance): AppInfo | null {
  for (const raw of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // a malformed block shouldn't hide a valid one elsewhere
    }
    const app = findAppNode(parsed);
    if (app) {
      const info = normalize(app, prov);
      if (hasMetadata(info)) {
        return info;
      }
    }
  }
  return null;
}
