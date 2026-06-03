import type { StealthPreset } from "./types.js";

// Bun auto-loads `.env` (and `.env.production`, etc.) — no dotenv needed.
// This module is the single place env vars are read and normalized.

function bool(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
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
} as const;
