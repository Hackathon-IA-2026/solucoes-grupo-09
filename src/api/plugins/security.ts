import { Elysia } from "elysia";
import { config } from "../../config.js";

// Strict default policy for the JSON API: only same-origin anything.
const API_CSP = "default-src 'self'";

// Relaxed policy for the Swagger UI, which pulls its assets from jsDelivr.
const SWAGGER_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: https://cdn.jsdelivr.net",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "connect-src 'self'",
].join("; ");

/** The Swagger UI is served under /docs and needs the relaxed CSP. */
export function cspFor(pathname: string): string {
  return pathname.startsWith("/docs") ? SWAGGER_CSP : API_CSP;
}

/**
 * Security headers applied to every response (success and error alike — set in
 * `onRequest`, which runs before routing/validation, so the headers survive
 * even on 4xx/5xx). HSTS is only sent in production, where TLS is terminated.
 */
export const securityHeaders = new Elysia({ name: "security-headers" })
  .onRequest(({ request, set }) => {
    set.headers["content-security-policy"] = cspFor(new URL(request.url).pathname);
    set.headers["x-content-type-options"] = "nosniff";
    set.headers["x-frame-options"] = "DENY";
    set.headers["x-xss-protection"] = "1; mode=block";
    set.headers["referrer-policy"] = "strict-origin-when-cross-origin";
    if (config.isProd) {
      set.headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
    }
  })
  // Lift the hook to global scope so it runs for every route (incl. plugins).
  .as("global");
