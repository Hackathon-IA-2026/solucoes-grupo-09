declare global {
  /** Runtime API-origin override — set before the bundle runs (web only). */
  // eslint-disable-next-line no-var
  // biome-ignore lint/nursery/useVarsOnTop: a global augmentation can only be declared with `var`
  var __WATTSTEER_API_URL__: string | undefined;
}

/**
 * API origin, in priority order:
 * 1. `globalThis.__WATTSTEER_API_URL__` — runtime override; lets a host page
 *    (or the e2e suite) point an already-built bundle at any API without a
 *    rebuild, since `EXPO_PUBLIC_*` values are frozen at bundle time.
 * 2. `EXPO_PUBLIC_API_URL` — inlined at build time.
 * 3. localhost dev default (`bun run api` at the repo root).
 */
export const API_URL =
  globalThis.__WATTSTEER_API_URL__ ??
  process.env.EXPO_PUBLIC_API_URL ??
  "http://localhost:3000";

/** Canonical site origin for SEO tags. */
export const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? "https://wattsteer.com";
