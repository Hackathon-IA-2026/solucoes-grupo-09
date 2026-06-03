import type { StealthPreset } from "./types.js";

// Bun auto-loads `.env` (and `.env.production`, etc.) — no dotenv needed.
// This module is the single place env vars are read and normalized.

function bool(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** Parse an int env var, clamped to [min, max], falling back to `def`. */
function int(value: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const stealth = process.env.NOVIQ_STEALTH;
const VALID_STEALTH: StealthPreset[] = ["max", "balanced", "fast"];

export const config = {
  /** API server port (Railway/most PaaS inject PORT). */
  port: Number(process.env.PORT ?? 3000),
  /** Node environment. */
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",
  /**
   * Public base URL for the OpenAPI `servers` entry (e.g.
   * https://noviq.up.railway.app). Omit to let Swagger UI use the origin it was
   * loaded from — correct for both localhost and most deployments.
   */
  publicUrl: process.env.NOVIQ_PUBLIC_URL || undefined,
  /** Default upstream proxy applied to scrapes when the caller omits one. */
  defaultProxy: process.env.NOVIQ_PROXY || undefined,
  /** Match browser geo/locale to the (proxy) exit IP by default. */
  geoip: bool(process.env.NOVIQ_GEOIP),
  /** Default stealth preset. */
  defaultStealth: (VALID_STEALTH.includes(stealth as StealthPreset)
    ? (stealth as StealthPreset)
    : "max") as StealthPreset,
  /**
   * Run Chromium without its setuid sandbox + small /dev/shm. Required inside
   * containers; left off locally so the sandbox (and full stealth) stays on.
   */
  noSandbox: bool(process.env.NOVIQ_NO_SANDBOX),

  // --- resilience / resource control ---
  /** Max scrapes running at once (each launches a Chromium). Tune to host RAM. */
  maxConcurrency: int(process.env.NOVIQ_MAX_CONCURRENCY, 2, 1, 64),
  /** Max scrapes allowed to queue before returning 503. */
  maxQueue: int(process.env.NOVIQ_MAX_QUEUE, 20, 0, 10_000),
  /** Hard time budget per scrape (ms); partial results returned, else 504. */
  scrapeTimeoutMs: int(process.env.NOVIQ_SCRAPE_TIMEOUT_MS, 120_000, 5_000, 600_000),
  /** Page-navigation timeout (ms). */
  navTimeoutMs: int(process.env.NOVIQ_NAV_TIMEOUT_MS, 60_000, 5_000, 180_000),
  /** Per in-page fetch timeout (ms) — bounds a stalled network. */
  fetchTimeoutMs: int(process.env.NOVIQ_FETCH_TIMEOUT_MS, 30_000, 2_000, 120_000),
  /** Bounded retries on transient navigation/network failures. */
  navRetries: int(process.env.NOVIQ_NAV_RETRIES, 2, 0, 5),
} as const;
