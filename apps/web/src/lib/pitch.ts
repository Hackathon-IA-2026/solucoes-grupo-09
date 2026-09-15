/**
 * Where the pitch deck lives, named once.
 *
 * The deck is a **static asset, not a bundled one**: it sits in
 * `apps/web/public/`, which `expo export` copies verbatim into `dist/` and the
 * Dockerfile already copies into the build stage (`COPY apps/web/public`), so
 * the browser gets the file straight from `server.ts` with no bundler step in
 * between. The consequence worth stating is the failure mode: nothing in the
 * module graph would break if the file went missing — the page would render an
 * empty frame and say nothing — which is why `test/pitch.test.ts` asserts the
 * bytes on disk rather than an import.
 *
 * Kept free of React and React Native imports for the same reason
 * `i18n/locale.ts` is, so a unit test can read these constants without the RN
 * runtime.
 *
 * Measured on the committed file: 706,193 bytes, `%PDF-1.4`, 10 pages, each
 * `/MediaBox [0 0 1080 607.92]`, `Producer (Skia/PDF m152)` — a browser print
 * of 16:9 slides.
 *
 * On committing it: at 706 KB it is the second-largest tracked file in the
 * repository, behind `apps/api/test/fixtures/ons/BALANCO_ENERGIA_SUBSISTEMA_
 * 2026.parquet` at 1.39 MB and twice `assets/images/logo-glow.png` at 331 KB.
 * `.gitignore` excludes no asset path and there is no LFS or size gate here, so
 * it goes in the tree — and the alternative would put the deck outside the
 * static export that the deploy, the Dockerfile and `server.ts` are all built
 * around, for a file that changes about as often as the logo does.
 */

/** The deck's URL path. Served from `public/` at the site root. */
export const PITCH_PDF_PATH = "/wattsteer-pitch.pdf";

/** The route that frames it. */
export const PITCH_PATH = "/pitch";
