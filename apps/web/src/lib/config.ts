import { ZalytixClient } from "@zalytix/core";

declare global {
  /** Runtime API-origin override — set before the bundle runs (web only). */
  // eslint-disable-next-line no-var
  var __ZALYTIX_API_URL__: string | undefined;
}

/**
 * API origin, in priority order:
 * 1. `globalThis.__ZALYTIX_API_URL__` — runtime override; lets a host page (or
 *    the e2e suite) point an already-built bundle at any API without a
 *    rebuild, since `EXPO_PUBLIC_*` values are frozen at bundle time.
 * 2. `EXPO_PUBLIC_API_URL` — inlined at build time.
 * 3. localhost dev default (`bun run api` at the repo root).
 */
const API_URL =
  globalThis.__ZALYTIX_API_URL__ ??
  process.env.EXPO_PUBLIC_API_URL ??
  "http://localhost:3000";

export const client = new ZalytixClient(API_URL);

/** Canonical site origin for SEO tags. */
export const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? "https://zalytix.com";
