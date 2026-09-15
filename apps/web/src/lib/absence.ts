/**
 * What a screen says when the gateway will not answer — and, today, why.
 *
 * Two things live here because both were about to be written a third time.
 *
 * **1. The code off whatever the client threw.** `use-optimization.ts` and
 * `use-replay.ts` each carried their own `refusalOf`, identical down to the
 * comment. Two spellings of a rule are two answers to the question a screen
 * actually asks — "is this a refusal I can name, or did we never reach the
 * gateway at all" — so there is one here and the hooks import it.
 *
 * **2. Why the forecast is missing, as of today.** This is the part worth
 * reading, because it is the state the product is in and not a hypothetical:
 *
 * > `GET /v1/meta`, production, 2026-09-15: both serving lanes report
 * > `state: "present_unpromoted"`, `usable: false`, `artifact_id: null`.
 * > The hot-swap gate refused the only artifact on each lane —
 * > `coverage_p10_in_band` 0.8114 against [0.85, 0.97] on the late lane — and
 * > the retrain that may fix it has not run. `forecast.latest_published` is
 * > empty.
 *
 * The consequence for these screens is exact, and it is **not** the one
 * `api-surface.md` §"no promoted artifact" describes. That section says the
 * screens see `MODEL_UNAVAILABLE`; they do not. `/v1/forecast/day-ahead`,
 * `/v1/grid/outlook` and `/v1/diagnosis/day-ahead` all resolve from Postgres
 * and are structurally unable to know a lane state — `apps/api/src/api/
 * forecast.ts` says so in as many words, and `apps/api/test/
 * forecast-day-ahead.test.ts` asserts the route never answers
 * `MODEL_UNAVAILABLE`. What they answer with nothing promoted is
 * `FORECAST_NOT_YET_PUBLISHED` (tomorrow, before the gate) or
 * `FORECAST_UNAVAILABLE` (the gate passed and the publication job wrote
 * nothing), and both messages end "See /v1/meta for the artifact lane state."
 *
 * So a screen that renders only the refusal code tells the reader a forecast is
 * missing and leaves them to guess whether the model is broken, the job failed
 * or the gate simply has not struck yet. The code is the clause that refused;
 * the lane state is the reason behind it; both are read here, together, because
 * separately neither is the answer.
 *
 * **What is deliberately not rendered.** `MetaLane.unusableReason` is the
 * gate's own prose — "guardrails: coverage_p10_in_band: 0.8114 against [0.85,
 * 0.97] …" — in English, from the modelling service. It is the most specific
 * thing in the building and it is developer prose in the same status as an
 * error envelope's `message`: `apps/web/test/error-copy.test.ts` forbids a
 * screen rendering that, and a bilingual product may not print an English
 * paragraph to a Portuguese reader. So the lane's **state** travels to the
 * screen as a code and the dictionaries say the words; the evidence stays in
 * `/v1/meta` for an operator, which is who it was written for.
 */

import type { ErrorCode } from "@wattsteer/core";
import type { Meta, MetaLane } from "@wattsteer/core/api";
import { ApiError } from "@wattsteer/core/client";

/**
 * The code off whatever the client threw.
 *
 * A failure that never reached the gateway has no code — the browser is
 * offline, or the origin is misconfigured — and `UPSTREAM_UNAVAILABLE` is the
 * honest reading of it from here: the service this screen depends on could not
 * be reached. It is deliberately not one of the route's own codes, which would
 * claim knowledge of a service we never spoke to.
 */
export function refusalOf(cause: unknown): ErrorCode {
  if (cause instanceof ApiError && cause.code !== null) {
    return cause.code;
  }
  return "UPSTREAM_UNAVAILABLE";
}

/**
 * The four lane conditions `/v1/meta` publishes, narrowed to what a reader
 * needs.
 *
 * `MetaLane.state` is the modelling service's vocabulary and it has four
 * members, not three — `apps/api/src/api/meta.ts` keeps `unresolvable` apart
 * from `no_artifact` on the grounds that mapping one onto the other would
 * report a damaged volume as an untrained lane. The distinction survives here
 * for the same reason: the repair is different in every case, and the reader of
 * this product is often the person who has to make it.
 */
export type LaneCondition = MetaLane["state"];

/** One lane, as the chrome and the honesty notes render it. */
export interface Lane {
  /** The lane directory name — data, never translated. */
  readonly name: string;
  readonly condition: LaneCondition;
  /**
   * Whether this lane can answer a forecast right now: promoted **and**
   * loadable. `undefined` when the modelling service is too old to report it,
   * which is not the same as `false` — so it is read as "unknown" and never
   * rounded down to a claim.
   */
  readonly usable: boolean | undefined;
}

/** Every serving lane `/v1/meta` knows about, in the order it published them. */
export function lanesOf(meta: Meta): readonly Lane[] {
  return meta.model.lanes.map((lane) => ({
    name: lane.lane,
    condition: lane.state,
    usable: lane.usable,
  }));
}

/**
 * Whether any lane could serve a forecast — the one question the chrome asks.
 *
 * A lane counts only when it is promoted *and* not reported unusable. An
 * artifact the hot-swap gate marked invalid against the live feature contract
 * is promoted and still serves nothing, which is why `state` alone is not the
 * test; `usable === undefined` is the modelling service declining to say, and
 * a promoted lane is given the benefit of that doubt rather than being called
 * broken on a field that was never sent.
 *
 * `false` when the modelling service is unreachable, because `lanes` is empty
 * then — which is correct: nothing can be served, and the reason is on the
 * `model.reachable` flag for whoever needs it.
 */
export function anyLaneServing(lanes: readonly Lane[]): boolean {
  return lanes.some((lane) => lane.condition === "promoted" && lane.usable !== false);
}
