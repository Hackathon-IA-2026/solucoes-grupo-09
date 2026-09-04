import { Elysia, t } from "elysia";
import { CodedError, UpstreamError } from "../errors.js";
import { callMl, type MlEndpoint, mapUpstreamFailure } from "./ml-proxy.js";

/**
 * The replayable calendar — which past days can be replayed honestly, and why
 * the others are refused.
 *
 * `docs/specs/replay.md`, "The endpoint": `GET /v1/replay/days` returns the
 * calendar, **server-evaluated**, and every refusal is a typed code rather than
 * a translated string.
 *
 * ### Why this one is a proxy when `/v1/forecast/day-ahead` is not
 *
 * The forecast route resolves entirely from Postgres, and it does so precisely
 * because the gateway has no artifact volume: the day row carries
 * `trained_through` and the risk-bin edges so that nothing has to ask the
 * modelling service for them.
 *
 * The replayable predicate cannot be answered that way, and the reason is the
 * ticket's whole substance. The held-out property is re-asserted **against the
 * artifact card's own recorded windows** — both of them — and the card records
 * a *calibration* window that no forecast row carries. `trained_through` alone
 * answers a weaker question, and the prototype's `date <= MODEL_TRAINED_THROUGH`
 * is exactly that weaker question asked of the wrong artifact. So the assertion
 * runs where the cards are, and this module forwards.
 *
 * The alternative — teach the gateway the predicate and fetch the windows over
 * the wire — would put a second implementation of the assertion on the far side
 * of a network hop from the documents it asserts against, which is the class of
 * arrangement this project keeps ruling out.
 *
 * ### What the gateway still owns
 *
 * The public surface: CORS, the read budget, the error envelope, and the closed
 * error vocabulary. `ml-proxy.ts` admits upstream's code into `ERROR_CODES`
 * rather than forwarding a body, so `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW` reaches
 * a client as a 422 with a code the web app has copy for, and a
 * `REPLAY_INTEGRITY_VIOLATION` reaches it as a 500 — never as a badge over a
 * number, which is the failure mode the spec exists to prevent.
 *
 * ### The lane is required, and that is a decision left open on purpose
 *
 * Post-go-live the forecaster serves two lanes, so a `served` day has two
 * candidate forecasts, and `replay.md` uses `gate_at(d, gate_late)` in one place
 * and the generic `gate_at(d, gate_profile)` in another. Nothing here picks. The
 * caller names a lane, the answer echoes it, and every day carries
 * `candidate_lanes` so that a day with two is visibly a day with two rather than
 * one silently resolved by a default in a query-string.
 */

/** The reply is the modelling service's, unchanged. */
export type ReplayCalendarBody = Record<string, unknown>;

/**
 * Forward one replay read, or throw the failure that says whose fault it was.
 *
 * The body is returned as it arrived. It is already `snake_case` — the wire
 * casing `api-surface.md` fixes and the one Python emits — so re-encoding it
 * here would be a second translator, which `packages/core/src/wire.ts` is the
 * only one of.
 */
async function forward(
  path: string,
  query: URLSearchParams,
  endpoint?: MlEndpoint,
): Promise<ReplayCalendarBody> {
  const response = await callMl(
    path,
    query,
    ...(endpoint === undefined ? [] : [endpoint]),
  );
  if (!response.ok) {
    // `mapUpstreamFailure` keeps a recognised code at the status upstream chose,
    // which is what keeps the four replay refusals apart: two 422s about the
    // date and two 404s about the data are four different sentences and must
    // not collapse into one "no".
    throw await mapUpstreamFailure(response);
  }
  const body = await response.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    throw new UpstreamError("The ML service returned an unreadable replay calendar", {
      code: "UPSTREAM_FAILED",
    });
  }
  return body as ReplayCalendarBody;
}

/** `YYYY-MM-DD`, and a civil date rather than an instant. */
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function civilDate(label: string, raw: string): string {
  if (!CIVIL_DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    // Refused here rather than forwarded: a malformed date is a statement about
    // the request, and `REPLAY_DATE_OUT_OF_RANGE` is a statement about the
    // window. Rounding the first to the second would tell a caller their date is
    // outside a range when it is not a date.
    throw new CodedError("BAD_INPUT", `${label} must be a civil date, YYYY-MM-DD`);
  }
  return raw;
}

const LANE_DESCRIPTION =
  "The artifact lane a replay is pinned to, e.g. dessem_free_v1__gate_late__thr5. " +
  "Required and never defaulted: a post-go-live day has one candidate forecast " +
  "per served lane, and no rule yet says which one a replay is of.";

export function createReplayRoutes(endpoint?: MlEndpoint) {
  return new Elysia({ name: "replay" })
    .get(
      "/v1/replay/days",
      async ({ query }) => {
        const params = new URLSearchParams({
          subsystem: query.subsystem,
          lane: query.lane,
        });
        if (query.from !== undefined) {
          params.set("from", civilDate("from", query.from));
        }
        if (query.to !== undefined) {
          params.set("to", civilDate("to", query.to));
        }
        return forward("/v1/replay/days", params, endpoint);
      },
      {
        query: t.Object({
          subsystem: t.String({
            description: "ONS subsystem code: N, NE, S or SE. There is no SIN.",
          }),
          lane: t.String({ description: LANE_DESCRIPTION }),
          from: t.Optional(
            t.String({ description: "Window start. Defaults to the data window." }),
          ),
          to: t.Optional(
            t.String({ description: "Window end. Defaults to yesterday, BRT." }),
          ),
        }),
        detail: {
          summary: "Which days are replayable, and why the others are refused",
          description:
            "Every day of the window with a verdict on each. A replayable day " +
            "carries its provenance (served | fold_holdout), its " +
            "VintageFidelity, and `held_out_by` naming the fold, the artifact " +
            "and **both** of the artifact's recorded windows. A refused day " +
            "carries the code of the clause that failed — never a computed " +
            "answer with a caveat over it.",
        },
      },
    )
    .get(
      "/v1/replay/days/:date",
      async ({ params, query }) => {
        const search = new URLSearchParams({
          subsystem: query.subsystem,
          lane: query.lane,
        });
        return forward(
          `/v1/replay/days/${civilDate("date", params.date)}`,
          search,
          endpoint,
        );
      },
      {
        params: t.Object({ date: t.String({ description: "The civil day, BRT." }) }),
        query: t.Object({
          subsystem: t.String({ description: "ONS subsystem code." }),
          lane: t.String({ description: LANE_DESCRIPTION }),
        }),
        detail: {
          summary: "One day, answered at the status of the clause that refused it",
          description:
            "422 REPLAY_DATE_OUT_OF_RANGE or REPLAY_DATE_BEFORE_HOLDOUT_WINDOW; " +
            "404 REPLAY_FORECAST_UNAVAILABLE or REPLAY_OBSERVATION_INCOMPLETE; " +
            "500 REPLAY_INTEGRITY_VIOLATION when the read-time held-out " +
            "assertion fails, which is a WattSteer bug and is logged with the " +
            "artifact id.",
        },
      },
    );
}

/**
 * The gateway's instance, mounted in `index.ts`. The factory above stays
 * exported so a test can point the same routes at a stub upstream — the failure
 * mapping is half of what this module is for, and it is unreachable from a
 * module-level constant.
 */
export const replayRoutes = createReplayRoutes();
