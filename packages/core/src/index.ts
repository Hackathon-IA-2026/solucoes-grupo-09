/**
 * `@wattsteer/core` — the vocabulary both sides of the wire share.
 *
 * **Two things are deliberately not re-exported here**, and the reason is the
 * same for both: they are a different layer, and merging them would put two
 * meanings on one name.
 *
 *  - `@wattsteer/core/api` — `src/types.generated.ts`, the generated wire
 *    contract. Its `Band`, `Driver` and `ForecastOrigin` are the *schema's*
 *    view of those nouns; the ones below are the app's algebra over them
 *    (`Figure`, `band()`, `producerLabel`). Star-exporting both would collide,
 *    and resolving the collision by renaming one would be exactly the "two
 *    definitions of a domain type" this package exists to remove.
 *    `test/wire-domain-agreement.test.ts` asserts the two are structurally
 *    identical wherever they share a name, so the seam is a seam and not a
 *    fork.
 *  - `@wattsteer/core/schema` — the JSON Schema loader. It reads files from
 *    disk and `apps/api/Dockerfile` ships `src/` only, so an import from a
 *    request path would pass every local check and die in the container.
 *
 * `@wattsteer/core/client` and `/wire` are exported from here as well as by
 * subpath, because nothing they export collides.
 */

export * from "./causality.js";
export * from "./client.js";
export * from "./constants.js";
export * from "./domain.js";
export * from "./errors.js";
export * from "./format.js";
export * from "./wire.js";
