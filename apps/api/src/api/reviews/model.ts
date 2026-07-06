import { Elysia, t } from "elysia";

const storeEnum = t.Union([t.Literal("apple"), t.Literal("google")], {
  description: "Which app store",
});

const sortEnum = t.Union(
  [t.Literal("mostRecent"), t.Literal("mostHelpful"), t.Literal("rating")],
  { description: "Sort order (rating is Google only)" },
);

const stealthEnum = t.Union(
  [t.Literal("max"), t.Literal("balanced"), t.Literal("fast")],
  { description: "Stealth preset trading speed for detection risk" },
);

/** A single normalized review, unified across stores. */
export const reviewSchema = t.Object({
  store: storeEnum,
  id: t.String(),
  userName: t.String(),
  title: t.String(),
  body: t.String(),
  // 1–5; normalizers emit 0 when the store omits the rating. No bounds here —
  // this is an *output* schema, and one odd upstream review must not turn a
  // successful scrape into a response-validation 500.
  rating: t.Number({ description: "1-5 (0 if missing upstream)" }),
  date: t.String({ description: "ISO-8601 timestamp" }),
  developerResponse: t.Nullable(t.Object({ body: t.String(), modified: t.String() })),
  thumbsUp: t.Optional(t.Number({ description: "Google only" })),
  appVersion: t.Optional(t.String({ description: "Google only" })),
  isEdited: t.Optional(t.Boolean({ description: "Apple only" })),
  appId: t.String(),
  country: t.String(),
});

/** Query string for the scrape endpoint. */
export const scrapeQuery = t.Object({
  appId: t.String({
    // Numeric id (Apple, e.g. 284882215) OR dotted package name (Google,
    // e.g. com.spotify.music). The pattern rejects junk like "undefined".
    // NOTE: no `examples` array here — that emits invalid OpenAPI 3.0 parameter
    // examples, which makes Swagger UI send the literal string "undefined".
    pattern: "^(\\d+|[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+)$",
    description:
      "Numeric id (Apple, e.g. 284882215) or package name (Google, e.g. com.spotify.music)",
  }),
  store: t.Optional(storeEnum),
  country: t.Optional(
    t.String({
      default: "us",
      pattern: "^[A-Za-z]{2}$",
      description: "2-letter storefront code",
    }),
  ),
  lang: t.Optional(t.String({ description: "Apple BCP-47 (en-US), Google short (en)" })),
  sort: t.Optional(sortEnum),
  limit: t.Optional(
    t.Numeric({ default: 50, minimum: 1, maximum: 500, description: "Max reviews" }),
  ),
  since: t.Optional(
    t.String({ description: "Stop at reviews older than this date (mostRecent only)" }),
  ),
  stealth: t.Optional(stealthEnum),
});

/** App-level metadata, unified across stores (every field may be null). */
export const appInfoSchema = t.Object({
  store: storeEnum,
  appId: t.String(),
  country: t.String(),
  name: t.Nullable(t.String()),
  developer: t.Nullable(t.String()),
  category: t.Nullable(t.String()),
  description: t.Nullable(t.String()),
  averageRating: t.Nullable(t.Number({ description: "Aggregate stars, e.g. 4.7" })),
  ratingCount: t.Nullable(t.Number()),
  price: t.Nullable(t.Number({ description: "0 = free" })),
  currency: t.Nullable(t.String()),
  version: t.Nullable(t.String()),
  contentRating: t.Nullable(t.String()),
  operatingSystem: t.Nullable(t.String()),
  icon: t.Nullable(t.String()),
  url: t.Nullable(t.String()),
});

/** Successful scrape response envelope. */
export const scrapeResponse = t.Object({
  store: storeEnum,
  appId: t.String(),
  country: t.String(),
  count: t.Number(),
  /** True when results were cut short by a timeout or a mid-stream error. */
  partial: t.Boolean(),
  reviews: t.Array(reviewSchema),
  /** App metadata captured in the same session (null if the page exposed none). */
  appInfo: t.Optional(t.Nullable(appInfoSchema)),
});

/** Query string for the metadata-only endpoint (no review knobs). */
export const appQuery = t.Object({
  appId: scrapeQuery.properties.appId,
  store: t.Optional(storeEnum),
  country: t.Optional(
    t.String({ default: "us", pattern: "^[A-Za-z]{2}$", description: "2-letter code" }),
  ),
  lang: t.Optional(t.String({ description: "Apple BCP-47 (en-US), Google short (en)" })),
  stealth: t.Optional(stealthEnum),
});

/** Metadata-only response envelope (GET /app). */
export const appResponse = t.Object({
  store: storeEnum,
  appId: t.String(),
  country: t.String(),
  appInfo: t.Nullable(appInfoSchema),
});

export const errorResponse = t.Object({ error: t.String() });

/** Returned when an async scrape job is accepted (202). */
export const jobAccepted = t.Object({
  id: t.String(),
  status: t.Literal("waiting"),
});

/** A job's status/result (GET /reviews/jobs/:id). */
export const jobRecord = t.Object({
  id: t.String(),
  status: t.Union([
    t.Literal("waiting"),
    t.Literal("active"),
    t.Literal("completed"),
    t.Literal("failed"),
  ]),
  result: t.Optional(scrapeResponse),
  error: t.Optional(t.String()),
  /** Live progress while active — drives client progress bars. */
  progress: t.Optional(
    t.Object({
      collected: t.Number({ description: "Reviews collected so far" }),
      limit: t.Optional(t.Number({ description: "Requested cap (bar denominator)" })),
    }),
  ),
});

/**
 * Reference models, injected with `.model()` so routes can refer to them by
 * name (and they show up in the OpenAPI schema as named components).
 */
export const reviewModel = new Elysia({ name: "reviews.model" }).model({
  "reviews.query": scrapeQuery,
  "reviews.response": scrapeResponse,
  "reviews.error": errorResponse,
  "reviews.job.accepted": jobAccepted,
  "reviews.job": jobRecord,
  "reviews.app.query": appQuery,
  "reviews.app.response": appResponse,
});
