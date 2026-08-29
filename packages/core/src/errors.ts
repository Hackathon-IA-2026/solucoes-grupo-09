/**
 * The error contract, published once for both sides of the wire.
 *
 * Every failure the API can produce arrives in **one envelope** carrying a
 * **stable code from a closed enum**. The gateway constructs it; the web app
 * translates it. Both import this file, which is the only reason the enum can
 * be called closed: a second definition anywhere is a second vocabulary.
 *
 * ```jsonc
 * { "error": {
 *     "code": "SHIFT_EXCEEDS_BASELINE",
 *     "message": "max_shift_mw (70) exceeds daily_energy_mwh / 24 (50).",
 *     "details": { "field": "assets[1].max_shift_mw", "limit": 50 },
 *     "request_id": "1f2c…"
 * } }
 * ```
 *
 * - **`code`** is the part a client acts on. Never translated, never reworded,
 *   never removed without a version bump. The client renders
 *   `t("error." + code)`; `docs/specs/i18n.md` requires exactly this.
 * - **`message`** is English developer prose, for logs and `/docs`. **It is
 *   never shown to a user.** A client that renders it has a bug, and
 *   `apps/web/test/error-copy.test.ts` is the check that says so.
 * - **`details`** is optional and typed per code, carrying the field path of a
 *   validation failure and the limit it broke.
 * - **`request_id`** echoes the id `request-context` already assigns, so a
 *   user-reported failure is one grep.
 *
 * The enum is the union of three vocabularies, and the gateway *repeats* the
 * other two rather than inventing parallel names for the same conditions —
 * a client that has to learn two vocabularies for one failure has no closed
 * enum at all:
 *
 * 1. the gateway's own (`docs/specs/api-surface.md`),
 * 2. the optimizer's validation and solve codes
 *    (`docs/specs/flex-optimizer.md`),
 * 3. Replay's five refusals (`docs/specs/replay.md`).
 *
 * An upstream code worth preserving is **admitted into this enum** rather than
 * smuggled past it as a free-form string, and the upstream *body* never
 * reaches a client: the envelope wins, and what survives is the status and the
 * code. Anything the enum has no room for travels in `details.upstream_code`.
 */

/** HTTP statuses this API can answer an error with. */
export type ErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500
  | 502
  | 503
  | 504;

const STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503, 504,
]);

/** `status` if this API can return it, `null` otherwise. */
export function asErrorStatus(status: number): ErrorStatus | null {
  return STATUSES.has(status) ? (status as ErrorStatus) : null;
}

/**
 * Every code this API can return, with the status it canonically answers with.
 *
 * The status lives here rather than at each throw site so that two routes
 * cannot answer the same condition with different numbers. A `ProxiedError` is
 * the single sanctioned exception: it carries the modelling service's own
 * status, because upstream knows more than we do about its own failure.
 */
export const ERROR_STATUS = {
  // --- the gateway's own ---
  /** Caller's input was wrong in a way no more specific code covers. */
  BAD_INPUT: 400,
  /**
   * A request body or query the route schema refused. The framework's native
   * validation body never reaches a client; its field path survives in
   * `details.field`.
   */
  REQUEST_INVALID: 422,
  /** No route matched. The framework's `{ error: "Not found" }` is gone. */
  ROUTE_NOT_FOUND: 404,
  /** Anything unexpected. Never carries detail to the client. */
  INTERNAL: 500,
  /** A data source outside WattSteer failed or was unreachable. */
  UPSTREAM_UNAVAILABLE: 502,
  /** The gateway itself is at capacity. */
  SERVICE_BUSY: 503,
  /** Body over the route's limit, refused on `Content-Length`. */
  PAYLOAD_TOO_LARGE: 413,

  // --- the four "no forecast" states, plus the publication failure ---
  /** The gate for that target date has not passed. Not an error on screen. */
  FORECAST_NOT_YET_PUBLISHED: 404,
  /** The gate passed and no rows exist — a publication failure. */
  FORECAST_UNAVAILABLE: 404,
  /** No promoted artifact in the requested lane. `details.lane_state` says which. */
  MODEL_UNAVAILABLE: 503,
  /** Postgres unreachable. The generic case, and the only generic sentence. */
  DATA_UNAVAILABLE: 503,
  /** A forecast exists; its attribution row does not. */
  DIAGNOSIS_UNAVAILABLE: 404,

  // --- this surface's own refusals ---
  /** Not one of the four subsystems. */
  SUBSYSTEM_UNKNOWN: 422,
  /** Before the data window opens, or beyond tomorrow. */
  TARGET_DATE_OUT_OF_RANGE: 422,
  /** An observed range longer than the published maximum. */
  DATE_RANGE_TOO_LARGE: 422,
  /** Not `gate_early` / `gate_late`. */
  GATE_PROFILE_UNKNOWN: 422,
  /** Primary subtag is neither `pt` nor `en`. See `resolveLocale`. */
  LOCALE_UNSUPPORTED: 422,
  /** Over the tier's budget. Always answered with `Retry-After`. */
  RATE_LIMITED: 429,

  // --- the modelling service, admitted rather than smuggled ---
  /** `WATTSTEER_ML_URL` is unset: the capability is absent, not broken. */
  OPTIMIZER_NOT_CONFIGURED: 502,
  /** The modelling service could not be reached at all. */
  OPTIMIZER_UNAVAILABLE: 502,
  /** The modelling service did not answer within `mlTimeoutMs`. */
  OPTIMIZER_TIMEOUT: 503,
  /** The modelling service answered 502/503/504: up, but cannot serve yet. */
  OPTIMIZER_NOT_READY: 503,
  /**
   * The modelling service refused the request (4xx) with a code this enum has
   * no room for. The upstream code travels in `details.upstream_code`.
   */
  UPSTREAM_REJECTED: 400,
  /** The modelling service failed (5xx) with a code this enum has no room for. */
  UPSTREAM_FAILED: 502,

  // --- the solve (docs/specs/flex-optimizer.md) ---
  SOLVER_GAP_UNCLOSED: 503,
  SOLVER_TIMEOUT: 504,
  SOLVER_BUG: 500,

  // --- the optimizer's validation table, verbatim ---
  SCENARIO_VERSION_UNSUPPORTED: 422,
  SCENARIO_TOO_LARGE: 422,
  ASSET_TYPE_UNKNOWN: 422,
  SUBSYSTEM_MISMATCH: 422,
  FIELD_NOT_ON_VARIANT: 422,
  MAGNITUDE_OUT_OF_RANGE: 422,
  RTE_OUT_OF_RANGE: 422,
  EFFICIENCY_PAIR_INCOMPLETE: 422,
  SOC_BOUNDS_INVALID: 422,
  SOC_INITIAL_OUT_OF_BOUNDS: 422,
  POWER_LIMIT_INCONSISTENT: 422,
  SHIFT_EXCEEDS_CONNECTION: 422,
  SHIFT_EXCEEDS_BASELINE: 422,
  SHIFT_WINDOW_OUT_OF_RANGE: 422,
  RECOVERY_TIME_OUT_OF_RANGE: 422,
  AVAILABILITY_INVALID: 422,
  ECONOMIC_ASSUMPTION_OUT_OF_RANGE: 422,

  // --- Replay's five refusals (docs/specs/replay.md) ---
  REPLAY_DATE_BEFORE_HOLDOUT_WINDOW: 422,
  REPLAY_DATE_OUT_OF_RANGE: 422,
  REPLAY_FORECAST_UNAVAILABLE: 404,
  REPLAY_OBSERVATION_INCOMPLETE: 404,
  /** The held-out assertion failed — a WattSteer bug, logged with the artifact id. */
  REPLAY_INTEGRITY_VIOLATION: 500,
} as const satisfies Record<string, ErrorStatus>;

/** A member of the closed code enum. */
export type ErrorCode = keyof typeof ERROR_STATUS;

/** Every code, in declaration order. */
export const ERROR_CODES = Object.keys(ERROR_STATUS) as readonly ErrorCode[];

const CODES: ReadonlySet<string> = new Set<string>(ERROR_CODES);

/** Is `value` a member of the closed enum? The gate an upstream code passes. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && CODES.has(value);
}

/** The status a code is canonically answered with. */
export function statusForCode(code: ErrorCode): ErrorStatus {
  return ERROR_STATUS[code];
}

/** Extra machine-readable context, typed per code. Never free-form prose. */
export type ErrorDetails = Record<string, string | number | boolean | null>;

/** The body of every error this API returns. There is no second shape. */
export interface ErrorEnvelope {
  error: {
    /** A member of the closed enum. The only field a client branches on. */
    code: ErrorCode;
    /** English developer prose. Logs and `/docs` only — never rendered. */
    message: string;
    /** Optional machine-readable context, typed per code. */
    details?: ErrorDetails;
    /** The `x-request-id` this failure was answered under. */
    request_id?: string;
  };
}

/** The translation key a client renders for a code. Never the `message`. */
export function errorCopyKey(code: ErrorCode): `error.${ErrorCode}` {
  return `error.${code}`;
}

/**
 * The four "no forecast" states, kept apart on purpose.
 *
 * "Not published yet", "no promoted artifact", "stale" and "the gateway is
 * down" are four different sentences, and `docs/specs/api-surface.md` exists
 * partly to stop a screen collapsing them into one spinner. Three are refusals
 * with their own code; the fourth — **stale** — is a `200`, because rows from
 * an earlier gate are a real forecast and hiding them would be the same lie in
 * the other direction. It is listed here so that "there are four" is a fact a
 * test can assert rather than a paragraph someone has to remember.
 */
export const NO_FORECAST_STATES = [
  {
    state: "not_yet_published",
    code: "FORECAST_NOT_YET_PUBLISHED",
    status: 404,
    /** Show today's forecast, dated, beside the next gate instant from `/v1/meta`. */
    screen: "shows_today_and_the_next_gate",
  },
  {
    state: "no_promoted_artifact",
    code: "MODEL_UNAVAILABLE",
    status: 503,
    /** Observed panels render; the forecast panels are absent, not skeletons. */
    screen: "observed_only",
  },
  {
    state: "stale",
    code: null,
    status: 200,
    /** The numbers render and the origin line states their age. */
    screen: "renders_with_origin_age",
  },
  {
    state: "gateway_unavailable",
    code: "DATA_UNAVAILABLE",
    status: 503,
    /** The generic case, and the only one that gets a generic message. */
    screen: "generic_retry",
  },
] as const satisfies readonly {
  state: string;
  code: ErrorCode | null;
  status: number;
  screen: string;
}[];

/** One of the four. */
export type NoForecastState = (typeof NO_FORECAST_STATES)[number]["state"];

/**
 * `details.lane_state` on a `MODEL_UNAVAILABLE`: which of the forecaster's
 * three artifact states holds. (The third, `promoted`, is not a refusal.)
 */
export const LANE_STATES = ["no_artifact", "present_unpromoted"] as const;
export type LaneState = (typeof LANE_STATES)[number];

/**
 * The locales this API will answer in, as full tags.
 *
 * **Matched on the primary subtag, never on the whole tag.** The web app's
 * `Locale` is `"pt" | "en"` and its `languageTag` helper emits `pt-BR` and
 * `en`, so an exact match against this set would have the gateway answer 422
 * to its own client. `pt*` resolves to `pt-BR`; `en*` to `en-US`.
 */
export const SUPPORTED_LOCALES = ["pt-BR", "en-US"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The locale a tag asks for, or `null` if its primary subtag is neither `pt`
 * nor `en` — which is the `LOCALE_UNSUPPORTED` condition, and the only one.
 */
export function resolveLocale(tag: string): SupportedLocale | null {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (primary === "pt") {
    return "pt-BR";
  }
  return primary === "en" ? "en-US" : null;
}
