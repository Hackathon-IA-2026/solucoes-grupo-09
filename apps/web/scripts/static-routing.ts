/**
 * How a request path becomes a file, and what status that file is served with.
 *
 * **One copy, because there were two.** `server.ts` serves the deployment and
 * `e2e/serve-dist.ts` serves the Playwright and Lighthouse runs, and the second
 * was a hand-written mirror of the first — its own comment said *"Mirrors
 * server.ts"*. That is the arrangement where a fix lands in one of them and the
 * suite quietly starts testing a server the deployment is not. It happened
 * immediately: the soft-404 repair below touched `server.ts` alone and made the
 * two disagree about a status code within the same edit.
 *
 * So the rule lives here and both import it. Neither can drift from the other
 * without changing this file, which is what the e2e suite is for.
 */

/**
 * The files to try, in order, for a cleaned request path.
 *
 * `${path}/index.html` is what makes the locale roots work: the export writes
 * `/pt/` as `dist/pt/index.html`, and a request for a directory has to find it.
 * `${path}.html` is what makes a deep route work — `/app/explain` is written as
 * `dist/app/explain.html`.
 *
 * @param path The pathname with leading and trailing slashes trimmed. `""` is
 *   the site root.
 */
export function candidatesFor(path: string): readonly string[] {
  return path === ""
    ? [SPA_FALLBACK]
    : [path, `${path}.html`, `${path}/index.html`, SPA_FALLBACK];
}

/** The last resort: `/`'s document, for a path no file matched. */
export const SPA_FALLBACK = "index.html";

/**
 * The status for the file that matched.
 *
 * **A fallback is a 404, and used not to be.** Every unknown path answered
 * `200` with `/`'s HTML, which is a *soft 404* — Google's own term. It spends
 * crawl budget on URLs that do not exist and can get them indexed. Measured on
 * production: `GET /nope` answered `200`.
 *
 * What is deliberately unchanged is the page a reader sees. Serving
 * `+not-found.html` instead was tried and is worse: under this export that
 * route prerenders to a near-empty shell with no title and no copy, so a reader
 * would get a blank frame where they get the branded loading screen today. The
 * status was the part that was lying; the page was not.
 *
 * `/pt/nope` was always right and still is — the router matches `+not-found`
 * inside the locale segment and renders it — and it now carries the status to
 * match. Only paths the router never got to decide about were wrong.
 *
 * Nothing legitimate is caught. Under `web.output: "static"` every real route
 * is prerendered to a file and is found by one of the three candidates tried
 * first. `path === ""` is the real root, which resolves to the same file, so
 * the test is whether we arrived here by exhausting the others.
 */
export function statusFor(path: string, candidate: string): 200 | 404 {
  return path !== "" && candidate === SPA_FALLBACK ? 404 : 200;
}
