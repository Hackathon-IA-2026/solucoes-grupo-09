import { NoviqClient } from "@noviq/core";

/**
 * API origin. `EXPO_PUBLIC_API_URL` is inlined at build time; the localhost
 * default matches the dev API (`bun run api` at the repo root).
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

export const client = new NoviqClient(API_URL);

/** Canonical site origin for SEO tags. */
export const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? "https://noviq.app";
