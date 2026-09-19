/**
 * `path` under `base`, keeping `base`'s own path.
 *
 * `new URL("/v1/…", base)` resolves a leading slash against the origin and
 * drops everything after it, so an API served under a prefix
 * (`https://host/app/8081`) was asked at `https://host/v1/…` and answered 403
 * (measured on 19/09/2026). This is the rule `packages/core`'s client already
 * follows, for the few URLs built outside it.
 */
export function apiUrl(base: string, path: string): URL {
  return new URL(path.replace(/^\//, ""), `${base.replace(/\/$/, "")}/`);
}
