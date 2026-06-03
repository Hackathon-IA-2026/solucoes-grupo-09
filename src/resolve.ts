import type { Store } from "./types.js";

/** A resolved scrape target. */
export interface Target {
  store: Store;
  appId: string;
}

/** One link in the resolution chain: recognize the input, or pass (`null`). */
export type Resolver = (input: string) => Target | null;

/**
 * Chain of Responsibility for turning a raw user input — a numeric Apple id, a
 * Google package name, or an App Store / Play Store URL — into a concrete
 * `{ store, appId }`. Each resolver inspects the input and either claims it or
 * defers to the next. Adding a new input form is just another link; no existing
 * resolver changes. This is the single source of truth shared by the CLI and
 * the library (previously duplicated across `parseAppId` and `inferStore`).
 */
export const RESOLVERS: Resolver[] = [
  // Apple numeric id — "284882215"
  (input) => (/^\d+$/.test(input) ? { store: "apple", appId: input } : null),
  // Apple store URL — https://apps.apple.com/us/app/instagram/id389801252
  (input) => {
    const m = input.match(/\/id(\d+)/);
    return m ? { store: "apple", appId: m[1] } : null;
  },
  // Google store URL — https://play.google.com/store/apps/details?id=com.x.y
  (input) => {
    const m = input.match(/[?&]id=([\w.]+)/);
    return m ? { store: "google", appId: m[1] } : null;
  },
  // Google package name — "com.spotify.music"
  (input) =>
    /^[A-Za-z]\w*(?:\.\w+)+$/.test(input) ? { store: "google", appId: input } : null,
];

/**
 * Resolve a raw id / package / store URL into `{ store, appId }`, trying each
 * link in `resolvers` until one claims it. Throws if none recognize the input.
 */
export function resolveTarget(input: string, resolvers: Resolver[] = RESOLVERS): Target {
  const trimmed = input.trim();
  for (const resolve of resolvers) {
    const target = resolve(trimmed);
    if (target) return target;
  }
  throw new Error(
    `Could not resolve a store + app id from "${input}". Pass a numeric Apple ` +
      `id, a Google package name (com.x.y), or an App Store / Play Store URL.`,
  );
}
