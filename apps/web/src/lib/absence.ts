/**
 * What a screen says when the gateway will not answer — and, today, why.
 *
 * **The lane half of this file moved to `lib/lanes.ts`.** It had grown a second
 * subject: `Lane`, `lanesOf` and `anyLaneServing` were the lane *table*, and the
 * serving rule they encode was being written a third and fourth time in two
 * hooks. That module owns it now and this one is about refusals again. What
 * stays here is the paragraph below, because "why is the forecast missing" is a
 * refusal's subject even when the answer is a lane's condition.
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
