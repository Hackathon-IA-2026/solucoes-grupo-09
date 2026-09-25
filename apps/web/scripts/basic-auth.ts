/**
 * An optional password in front of the whole site, for while the event runs.
 *
 * Off unless both `WATTSTEER_WEB_USER` and `WATTSTEER_WEB_PASSWORD` are set, so
 * local development and the e2e harness see the site exactly as before, and
 * removing the password afterwards is unsetting two variables, not a commit.
 *
 * This hides the screens only. `api.wattsteer.com` is a separate service and
 * stays public.
 */
import { timingSafeEqual } from "node:crypto";

export interface BasicAuth {
  user: string;
  password: string;
}

/** The configured credentials, or `null` when the site is open. */
export function basicAuthFrom(env: Record<string, string | undefined>): BasicAuth | null {
  const user = env.WATTSTEER_WEB_USER;
  const password = env.WATTSTEER_WEB_PASSWORD;
  return user && password ? { user, password } : null;
}

/**
 * Whether an `Authorization` header carries the configured credentials.
 *
 * The comparison is constant time, as in the API's `dashboard-guard.ts`: a
 * plain `===` leaks the matching prefix to anyone timing the response.
 */
export function basicAuthorized(header: string | null, auth: BasicAuth): boolean {
  const prefix = "Basic ";
  if (!header?.startsWith(prefix)) {
    return false;
  }
  const offered = Buffer.from(header.slice(prefix.length), "base64");
  const expected = Buffer.from(`${auth.user}:${auth.password}`);
  // `timingSafeEqual` throws on a length mismatch; compare lengths separately.
  const sameLength = offered.length === expected.length;
  return timingSafeEqual(sameLength ? offered : expected, expected) && sameLength;
}

/** The answer that makes a browser ask for the password. */
export function basicAuthChallenge(): Response {
  return new Response("authentication required", {
    status: 401,
    headers: {
      "content-type": "text/plain",
      "cache-control": "no-store",
      "www-authenticate": 'Basic realm="WattSteer", charset="UTF-8"',
    },
  });
}
