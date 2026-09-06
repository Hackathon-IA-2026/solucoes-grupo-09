/**
 * The caching table, in one place — **a cache key is a provenance, never a
 * duration.**
 *
 * `docs/specs/api-surface.md`, "Caching", is a table of twelve rows and one
 * rule — fifteen now, with the error row and the two reads that spec recorded
 * as a hole it was leaving open — and until this module existed it was twelve
 * copies of that rule: each
 * route assembled its own directive string and its own validator, and the only
 * thing keeping them agreeing was that they had been written on the same
 * afternoon. Two of them had already drifted — `/v1/forecast/day-ahead` carried
 * a validator built from the row's ingestion instant rather than from the
 * artifact and the publication, and no `stale-while-revalidate` at all — which
 * is exactly the drift a table transcribed twelve times produces.
 *
 * So the table lives here, once, and the routes name a row.
 *
 * ### The rule, and what it forbids
 *
 * Every entity on this surface already carries the thing that should invalidate
 * it — an `artifact_id`, a `published_at`, a `data_version`, an `ingested_at`,
 * a scenario hash, a computation id — and a validator built from those has **no
 * manual invalidation path to forget to call**. A key built from a TTL is a
 * guess about how fast the world changes; a key built from a provenance is a
 * statement that this response *is* that version.
 *
 * The distinction that matters, because both are instants: `published_at` and
 * `ingested_at` are facts about the **record** and belong in a validator.
 * `Date.now()` is a fact about the **request** and does not — a validator
 * carrying it changes on every request, which is a cache that never hits
 * wearing an ETag. `cache-policy.test.ts` reads the `etagOf` call sites and
 * asserts none of them mentions a clock or a TTL constant.
 *
 * ### Nothing here is `immutable`, and that is load-bearing
 *
 * ONS restates history in place — a whole year, under the same filenames, with
 * no version marker — so no response on this surface may be frozen. The
 * strongest thing this module does is make that checkable in one place: the
 * directives are assembled from the constants below and there is no
 * `immutable` among them, and because every `Cache-Control` on the surface is
 * assembled here, a grep over *this file* is a grep over every response.
 * `cache-policy.test.ts` runs both halves of that: no policy carries the
 * directive, and no route file writes a `cache-control` of its own.
 *
 * ### A read and a solve are not the same thing
 *
 * The `/v1/replay/days/<date>` date picker was once metered at the *solver's*
 * rate because it lived under `/v1/replay`; caching has the same trap, and it
 * is avoided the same way — by the route naming its row rather than inheriting
 * its neighbour's. A read gets a shared `max-age` and a validator; a `POST`
 * solve gets `no-store` and does its remembering in Redis behind the gateway,
 * where the key can carry a provenance a URL cannot.
 *
 * `/v1/canonical` is the same trap a third time, and it is why the manifest and
 * the reads under it are two rows: a static discovery document and a bitemporal
 * read share a path prefix and share nothing else.
 */

/**
 * The one directive that stores nothing.
 *
 * `/v1/meta`, the `POST` solves, the canonical reads and `/ingest/health`, and
 * for three different arguments rather than one. `/v1/meta` and
 * `/ingest/health` are what you read to discover something is broken, so a
 * cache in front of either is a cache in front of the truth; a `POST` is not
 * shared-cacheable at all; a canonical read is an as-of answer with no
 * validator, so a stored copy can only ever be the right rows for the wrong
 * instant. Each row below states its own; none of them inherits.
 */
const NO_STORE = "no-store";

/** Assembled rather than written as literals: see `SHARED` below. */
const SHARED = "public";

/** `max-age=<n>`, in seconds. */
function maxAge(seconds: number): string {
  return `max-age=${seconds}`;
}

/** `stale-while-revalidate=<n>` — what turns a publication failure into an older number. */
function staleWhileRevalidate(seconds: number): string {
  return `stale-while-revalidate=${seconds}`;
}

/**
 * A shared-cache directive from its parts.
 *
 * Assembled rather than written as one literal because the joined string trips
 * the repo's high-entropy secret lint, and a suppression comment on a
 * `Cache-Control` header would be the wrong thing to teach. It also means the
 * `immutable` assertion has one expression to read rather than twelve literals.
 */
function shared(...directives: readonly string[]): string {
  return [SHARED, ...directives].join(", ");
}

/**
 * The freshness windows, named so the table below reads as the spec's table.
 *
 * Five minutes on anything downstream of a forecast is not a decay estimate: a
 * forecast changes **twice** daily — `gate_early` at 09:00 BRT, `gate_late` at
 * 19:00 — and a window tuned to "daily" would serve the morning view for ten
 * hours after the evening view existed. Five minutes never crosses the next
 * gate, and the validator is what makes correctness independent of the clock.
 */
const FIVE_MINUTES_SEC = 300;
const ONE_MINUTE_SEC = 60;
const TEN_MINUTES_SEC = 600;
const ONE_HOUR_SEC = 3600;
const ONE_DAY_SEC = 86_400;

/** One row of the caching table. */
export interface CachePolicy {
  /** The row's name, for the assertions and for a reader following a stack. */
  readonly name: string;
  /** The `Cache-Control` value, verbatim. */
  readonly directive: string;
  /** The `Vary` value, on the one route that generates prose. */
  readonly vary?: string;
}

/**
 * The caching table — `docs/specs/api-surface.md`, "Caching", one row per key.
 *
 * The `Key` column of that table is not here, because a key is a property of
 * the *response* and not of the route: it is built at the call site out of the
 * provenance that answered, by `etagOf`. What is here is the half that is a
 * property of the route, and the pairing is asserted per route.
 */
export const CACHE_POLICIES = {
  /** `/v1/meta`. It is what you read to discover something is broken. */
  meta: { name: "meta", directive: NO_STORE },

  /**
   * `/v1/grid/outlook` and `/v1/forecast/day-ahead`.
   *
   * Key: `artifact_id` + `published_at` + max `data_version`. A superseding
   * 12Z run changes the validator **by construction** — it is a different
   * artifact published at a different instant — rather than by a TTL expiring.
   */
  forecast: {
    name: "forecast",
    directive: shared(maxAge(FIVE_MINUTES_SEC), staleWhileRevalidate(ONE_HOUR_SEC)),
  },

  /** `/v1/grid/now`. Key: the latest `ingested_at`, which moves hourly at best. */
  now: { name: "now", directive: shared(maxAge(ONE_MINUTE_SEC)) },

  /**
   * `/v1/curtailment/*` over a settled past range. Key: max `data_version` in
   * range. **Not `immutable`** — ONS rewrites history in place.
   */
  observedSettled: {
    name: "observed-settled",
    directive: shared(maxAge(ONE_HOUR_SEC), staleWhileRevalidate(ONE_DAY_SEC)),
  },

  /** `/v1/curtailment/*` touching the last 48 h. Same key; the tail is still settling. */
  observedTail: { name: "observed-tail", directive: shared(maxAge(FIVE_MINUTES_SEC)) },

  /**
   * `/v1/diagnosis/day-ahead`. Key: the attribution row's version **and** the
   * narration key — the pair that is already the response's identity, written
   * down. Nothing is stored under it: the two caches are the row and
   * `diagnosis.md`'s narration entry, and a third key over the composed
   * response would have its own drift.
   *
   * The only route that generates prose, so the only one that varies, and it
   * varies on one header.
   */
  diagnosis: {
    name: "diagnosis",
    directive: shared(maxAge(FIVE_MINUTES_SEC)),
    vary: "Accept-Language",
  },

  /** `/v1/model/card`. Key: `artifact_id`. Changes only on promotion. */
  modelCard: { name: "model-card", directive: shared(maxAge(ONE_HOUR_SEC)) },

  /**
   * `GET /v1/optimize?s=` — the share and deep-link form.
   *
   * A shared link is shared-cacheable: the answer is a function of the blob,
   * the resolved origin and the optimizer build, none of which is the reader.
   * Five minutes because the scenario was planned against a band that
   * supersedes twice a day.
   */
  solveShared: { name: "solve-shared", directive: shared(maxAge(FIVE_MINUTES_SEC)) },

  /**
   * `POST /v1/optimize`, `POST /v1/replay`, `POST /v1/replay/observed-only`.
   *
   * Not shared-cacheable; Redis does that work behind the gateway, under the
   * same key the `GET` would have hit.
   */
  solveBody: { name: "solve-body", directive: NO_STORE },

  /**
   * `GET /v1/replay?d=&s=`.
   *
   * Ten minutes and not the optimizer's five, because the two halves age
   * differently: a replay's forecast half is a pinned historical row no gate
   * can supersede. What can still move underneath it is the *observed* half,
   * so this is a `max-age` and never `immutable`.
   */
  replay: { name: "replay", directive: shared(maxAge(TEN_MINUTES_SEC)) },

  /**
   * `/v1/replay/days`, `/v1/replay/days/<date>` and `/v1/backtest`.
   *
   * Key: the featured-days computation id — a digest over the basis the
   * shortlist was computed from, so a rerun that moves a single hour of a
   * single day moves the validator. An hour and not the replay's ten minutes
   * because a day's *verdict* moves only when a fold calendar, an artifact
   * promotion or a settled-hour count moves, none of which happens inside an
   * hour. Under-caching it would be a date picker that revalidates on every
   * keystroke — and it is a **read**, not a solve, which is the same
   * distinction `rate-limit.ts` had to make about this exact path.
   */
  featuredDays: { name: "featured-days", directive: shared(maxAge(ONE_HOUR_SEC)) },

  /** `/v1/plants`. Key: the registry snapshot's `ingested_at`. Daily SIGA/ONS. */
  registry: { name: "registry", directive: shared(maxAge(ONE_DAY_SEC)) },

  /**
   * **`/v1/canonical/<read>` — the nine bitemporal reads. `no-store`.**
   *
   * The row this table was missing, and the only one whose argument is about
   * time rather than about versions. Not `/v1/meta`'s reason — that one is
   * "a cache in front of the thing you read to discover something is broken" —
   * but the vintage one, which is sharper.
   *
   * A canonical read is parameterised by an `as_of` instant, and the answer is
   * every row whose `ingested_at` is at or before it. The tables are
   * append-only, so an `as_of` safely in the past names a fixed set of rows and
   * would be perfectly cacheable. **The ordinary call is not that call.** The
   * modelling side asks "what do we know now", which is an `as_of` at or after
   * the wall clock, and under a fixed URL that answer *grows* — every ingest
   * that lands adds rows that satisfy the same cut. A heuristically-cached copy
   * of that URL is a point-in-time answer served at the wrong point in time,
   * and the `vintage` receipt travelling inside the body still names the
   * `as_of` that was asked, so the staleness is invisible at exactly the layer
   * built to make vintage visible. `canonical_as_of()` **raises** rather than
   * defaulting to `now()` precisely so that a wrong-vintage answer is never
   * served silently; an intermediary inventing a freshness lifetime is the one
   * remaining path that reintroduces it.
   *
   * And the route cannot tell the two cases apart without comparing `as_of` to
   * a clock — which is the duration-as-a-key this module exists to forbid,
   * one level up.
   *
   * **Why not `no-cache` with a validator**, which would be the cheaper honest
   * answer: there is no validator to build. The identity of one of these
   * responses is a *set* of rows rather than a version — `max(data_version)`
   * does not move when a new business key arrives at version 1 — the composed
   * `training-window` read has seven contributing sources, and an answer with
   * no rows has no provenance at all. That last case is not hypothetical: it is
   * the shape of the `/v1/plants` defect, where the empty path reached for
   * `new Date()` because there was nothing else to key on. A `no-cache`
   * carrying no validator is a `no-store` that leaves a copy on disk, so the
   * honest directive is not to leave the copy.
   *
   * Nothing is given up. This surface's consumer is `apps/ml`, in-cluster and
   * behind no CDN; the reads it repeats it repeats under a different `as_of`,
   * which is a different key anyway.
   */
  canonical: { name: "canonical", directive: NO_STORE },

  /**
   * **`GET /v1/canonical` — the read manifest. Cacheable, and the reason to
   * give it its own row rather than let it inherit its path's.**
   *
   * `/v1/replay/days` had to be told it was a read and not a solve because it
   * lived under a solve's path; this is the same trap mirrored. The manifest
   * touches no database, takes no `as_of` and is a constant of the deployment:
   * the grain, business key and fact kind of each read, which change when the
   * code changes and at no other time. Giving it `no-store` because its
   * siblings have it would be copying `/v1/meta`'s reason to a route it does
   * not apply to.
   *
   * Key: a digest over the manifest the process will serve — a content
   * provenance, the same kind as a scenario hash, computed once at module load
   * and therefore a fact about the build rather than about the request. A
   * deploy that adds a read changes it by construction; nothing else can.
   */
  canonicalManifest: {
    name: "canonical-manifest",
    directive: shared(maxAge(ONE_HOUR_SEC)),
  },

  /**
   * **`GET /ingest/health` — the operations view. `no-store`, and this one *is*
   * `/v1/meta`'s reason.**
   *
   * It answers "has a source stopped moving", and it answers 503 when one has.
   * A cached 200 served while ingestion is down is not stale data, it is a
   * monitor that has been told everything is fine — which is the silence this
   * endpoint exists to break, with a cache as the thing doing the silencing.
   * Its whole value is being current, so a stored copy has no legitimate reuse
   * and there is nothing to revalidate against.
   *
   * It needs its own directive rather than the `error` row's even though it can
   * answer 503: that 503 is a *successful* report of an unhealthy system, a
   * status the handler sets on its own body, and it never passes through
   * `errors.ts` — so `refuseToCache` never sees it. The 200 is the dangerous
   * one anyway.
   */
  ingestHealth: { name: "ingest-health", directive: NO_STORE },

  /**
   * **Any error, on any route** — applied by `./errors.ts`, not by a handler.
   *
   * The row the table does not have and the surface needs, because a route
   * that revalidates *before* it does its work has already written a success
   * directive by the time the work fails. `/v1/optimize` is the sharp case: a
   * pinned scenario is 304-checked before the solver is called, so an upstream
   * 503 would otherwise be served under `public, max-age=300` **carrying the
   * validator the eventual 200 will carry** — a shared cache that stored the
   * failure would then revalidate it to a 304 and re-extend the window, which
   * is a cached outage with no expiry. A 503 is not shared-cacheable by
   * default, and the whole defect is that an explicit `max-age` overrides that
   * default.
   *
   * So the envelope clears the validator and says `no-store`, once, where every
   * error already passes. Putting it in the handlers instead would be twelve
   * more transcriptions of one rule, which is the thing this module exists to
   * stop.
   */
  error: { name: "error", directive: NO_STORE },
} as const satisfies Record<string, CachePolicy>;

/** Every row of the table, for the assertions that must hold of all of them. */
export const ALL_CACHE_POLICIES: readonly CachePolicy[] = Object.values(CACHE_POLICIES);

/**
 * One component of a provenance.
 *
 * A `Date` because `published_at` and `ingested_at` are instants, a `number`
 * because `data_version` is a counter, a `string` because an artifact id, a
 * scenario hash and a computation id are strings. `null` and `undefined` are
 * NOT accepted: a validator with a hole in it is a validator that collides
 * two different responses, and the call site has to say what it means by the
 * absence instead.
 */
export type ProvenancePart = string | number | Date;

/** How a `Date` enters a validator: ISO-8601, to the millisecond, in UTC. */
function rendered(part: ProvenancePart): string {
  return part instanceof Date ? part.toISOString() : String(part);
}

/**
 * A weak validator over a provenance — `W/"<part>:<part>:…"`.
 *
 * **Weak** on every route, deliberately. A strong validator is a promise about
 * bytes, and these responses embed a computed `as_of` and a lag; two responses
 * from one publication are the same *version* of the same fact without being
 * byte-identical, and weak comparison is the only one that says that.
 *
 * The shape is `diagnosis.ts`'s, generalised: it was already
 * `<ingested_at>-<data_version>-<narration key>` there, which is a provenance
 * written down. The separator is `:` because `api-surface.md`'s table writes it
 * that way and because an ISO instant contains `-`.
 */
export function etagOf(parts: readonly ProvenancePart[]): string {
  if (parts.length === 0) {
    // A validator over nothing is a validator every response matches, which
    // would turn revalidation into a 304 on a changed body.
    throw new Error("an ETag over no provenance is not a validator");
  }
  return `W/"${parts.map(rendered).join(":")}"`;
}

/**
 * The mutable slice of an Elysia `set` this needs, structurally — so the
 * policy module does not import the framework and the tests do not mount one.
 */
export interface MutableResponse {
  headers: Record<string, string | number | undefined>;
  status?: number | string;
}

/** The read slice of a `Request`. Same reason. */
export interface RevalidatingRequest {
  headers: { get(name: string): string | null };
}

/** What a route hands over: where to write, and what asked. */
export interface CacheContext {
  set: MutableResponse;
  request: RevalidatingRequest;
}

/**
 * Apply one row of the table, and say whether the body still has to be built.
 *
 * Returns `true` when the client already holds this exact version: the status
 * is 304 and the caller must return without a body. The headers are set
 * **before** the comparison, because a 304 carries the validator and the
 * directive it is refreshing — a 304 with no `ETag` is a revalidation the
 * client cannot repeat, and a 304 with no `Cache-Control` resets the freshness
 * window it exists to extend.
 *
 * `provenance` is omitted only where the spec says there is nothing to
 * revalidate: a `no-store` response has no stored copy to compare against, and
 * an ETag on one would be a validator for a version nobody may keep.
 */
/**
 * Take back a validator and a freshness window a handler had already written.
 *
 * For `./errors.ts`, and the reason it is here rather than there: an error is a
 * caching decision, and the one place that makes caching decisions is this
 * module. Deleting the `ETag` is the half that matters — a stored error whose
 * validator matches the success it replaces is an outage a shared cache can
 * refresh forever.
 */
export function refuseToCache(set: MutableResponse): void {
  set.headers["cache-control"] = CACHE_POLICIES.error.directive;
  delete set.headers.etag;
  delete set.headers.vary;
}

export function applyCachePolicy(
  context: CacheContext,
  policy: CachePolicy,
  provenance?: readonly ProvenancePart[],
): boolean {
  const { set, request } = context;
  set.headers["cache-control"] = policy.directive;
  if (policy.vary !== undefined) {
    set.headers.vary = policy.vary;
  }
  if (provenance === undefined) {
    return false;
  }
  const etag = etagOf(provenance);
  set.headers.etag = etag;
  if (request.headers.get("if-none-match") !== etag) {
    return false;
  }
  set.status = 304;
  return true;
}
