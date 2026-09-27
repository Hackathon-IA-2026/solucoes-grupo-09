declare global {
  /** Runtime API-origin override — set before the bundle runs (web only). */
  // eslint-disable-next-line no-var
  // biome-ignore lint/nursery/useVarsOnTop: a global augmentation can only be declared with `var`
  var __WATTSTEER_API_URL__: string | undefined;
  /** Runtime demo-date override, for the same reason as the one above. */
  // eslint-disable-next-line no-var
  // biome-ignore lint/nursery/useVarsOnTop: a global augmentation can only be declared with `var`
  var __WATTSTEER_DEMO_DATE__: string | undefined;
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

/**
 * The path the export is served under, `""` at a domain's root. Inlined at
 * build time with `experiments.baseUrl` (see `app.config.ts`), for the URLs
 * written by hand that expo-router cannot prefix.
 */
export const BASE_PATH = process.env.EXPO_PUBLIC_BASE_PATH ?? "";

/** Canonical site origin for SEO tags. */
export const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? "https://wattsteer.com";

/**
 * A civil date `/app` opens on instead of tomorrow, or `null` for the default.
 *
 * **What this is for, and what it is not.** The Overview opens on
 * `latestTargetDate` — tomorrow — because that is the day a forecast is about.
 * On a deployment whose publication has been interrupted, tomorrow has nothing
 * and a visitor meets four stated absences, which is honest and useless for a
 * demonstration. This pins the opening day to one that was published.
 *
 * It changes **which day the app opens on** and nothing else. The date is on
 * screen in the chip, both arrows move from it, and every figure below is that
 * day's own. A visitor is never shown one day's numbers under another day's
 * label — that would be the one thing this product must not do, and no flag
 * here could be worth it.
 *
 * Unset in normal operation. Same resolution order as `API_URL`: a runtime
 * global first, so an already-built bundle can be pinned without a rebuild,
 * then the build-time variable.
 */
export const DEMO_DATE: string | null =
  globalThis.__WATTSTEER_DEMO_DATE__ ?? process.env.EXPO_PUBLIC_DEMO_DATE ?? null;
