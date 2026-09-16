/**
 * The Explain screen's reads, against the **real** gateway.
 *
 * Built the way `use-network.ts` is and for the same reason — this screen's
 * reads do not fail together — but the seam falls in a different place, and the
 * honest answer today is bleaker.
 *
 * **What this screen is made of, and what each part needs.**
 *
 * | Panel | Read | Needs a promoted model |
 * |---|---|---|
 * | risk chip, the two bands | `GET /v1/forecast/day-ahead` | yes |
 * | driver bars, narration | `GET /v1/diagnosis/day-ahead` | yes |
 * | reliability curve | `GET /v1/model/card?lane=` | yes |
 * | observed restriction reasons | `GET /v1/curtailment/reasons` | **no** |
 *
 * With nothing promoted — which is production today, both lanes
 * `present_unpromoted` after the hot-swap gate refused the only artifact on
 * each — three of those four refuse and the fourth does not. So Explain is
 * mostly an absence right now, and it says so; the one panel that survives is
 * the one the screen's own header calls out as the reason the screen is not
 * entirely model output. `api-surface.md` says Explain is "disabled with the
 * same sentence" when no artifact is promoted, and that is one panel too broad:
 * the reasons ONS observed are a settled fact about a day that happened and no
 * model was ever involved in them.
 *
 * **Four states and no fifth**, the same four `use-network.ts` has, named the
 * same way so the two screens are read the same way:
 *
 *  - `reading` — in flight.
 *  - `explained` — the day is forecast and diagnosed.
 *  - `observedOnly` — the day's model reads refused; the observed reasons did
 *    not. Today's normal state.
 *  - `refused` — the observed reasons refused too, and nothing is left.
 *
 * **The model card is carried in both of the middle two, and that is
 * deliberate.** A card is keyed by **lane** and never by day
 * (`api-surface.md` §9: the reliability curve is a property of the model, not
 * of a day), so it can answer while a particular day's forecast has not been
 * published — a lane promoted this morning has a curve before tonight's gate
 * writes a forecast — and it can refuse while a day is perfectly well
 * forecast, if the lane a reader is on differs from the one that published. Two
 * independent questions, so two independent answers, and the curve lights up on
 * its own timetable rather than waiting for a day.
 *
 * **Why the forecast's code is the headline.** The forecast, the diagnosis and
 * the card can refuse with three different codes. The forecast's is the root:
 * `apps/api/src/api/diagnosis.ts` checks for the forecast first and answers the
 * forecast's own refusal when there is none, so a diagnosis code here would
 * almost always be the same fact said second. The card's is kept apart because
 * it is genuinely a different question.
 */

import type { ErrorCode } from "@wattsteer/core";
import type {
  DiagnosisDayAhead,
  ForecastDayAhead,
  GateProfile,
  ModelCard,
  ObservedReasons,
} from "@wattsteer/core/api";
import { useEffect, useState } from "react";
import { refusalOf } from "@/lib/absence";
import { api } from "@/lib/api";
import { settleWith } from "@/lib/settle";

/** The reliability curve, or the reason there is none. */
export type ModelCardState =
  | { readonly status: "card"; readonly card: ModelCard }
  | { readonly status: "refused"; readonly code: ErrorCode };

/** What needs no model: the reasons ONS recorded. */
export interface ObservedExplain {
  readonly reasons: ObservedReasons;
  readonly card: ModelCardState;
}

/** The day, as the model sees it. */
export interface DiagnosedDay {
  readonly forecast: ForecastDayAhead;
  readonly diagnosis: DiagnosisDayAhead;
}

export type ExplainState =
  | { readonly status: "reading" }
  | {
      readonly status: "explained";
      readonly observed: ObservedExplain;
      readonly day: DiagnosedDay;
    }
  | {
      readonly status: "observedOnly";
      readonly observed: ObservedExplain;
      /** The clause that refused the day, from the closed enum. */
      readonly code: ErrorCode;
    }
  | { readonly status: "refused"; readonly code: ErrorCode };

const MS_PER_DAY = 86_400_000;

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

export interface ExplainQuery {
  readonly subsystem: string;
  /** The day being forecast — tomorrow, in Brasília. */
  readonly targetDate: string;
  readonly gateProfile: GateProfile;
  /**
   * The lane whose card the reliability panel describes.
   *
   * Required and never defaulted inside the hook, for the reason the gateway
   * gives about `/v1/replay`: which artifact family a reader's numbers came
   * from is a property of the deployment, discoverable at `/v1/meta`, and a
   * default invented in a hook would be this module deciding it.
   */
  readonly lane: string;
  /**
   * The reader's locale, as a BCP-47 tag.
   *
   * The one parameter on this screen that is about the reader rather than the
   * grid. `/v1/diagnosis/day-ahead` is the only endpoint that varies by locale,
   * because it is the only one that returns generated prose — `docs/specs/
   * i18n.md` carves that single exception out of "the API returns codes, the
   * client renders the words". Switching language therefore re-requests the
   * diagnosis, which is correct and is why it is in the effect's key.
   */
  readonly locale: string;
}

export function useExplain(query: ExplainQuery): ExplainState {
  const { subsystem, targetDate, gateProfile, lane, locale } = query;
  const [state, setState] = useState<ExplainState>({ status: "reading" });

  useEffect(() => {
    const controller = new AbortController();
    const settle = settleWith(controller.signal, setState);
    const signal = controller.signal;
    // The first statement of a fetch effect, not a cascade: the key changed,
    // so the answer on screen is about a question nobody is asking any more
    // and saying so is the point. Deriving it before render cannot work —
    // "reading" is a fact about a request that render did not make.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    setState({ status: "reading" });

    // The most recent local day that can have settled. ONS publishes the
    // restriction detail a day or more behind, so asking about the day being
    // forecast would return an empty table — and an empty reasons table reads
    // as "nothing was curtailed", which is a claim.
    const settled = daysBefore(targetDate, 2);

    // Independent of everything below: a lane's card is a property of the
    // model, so it neither waits for a day nor blocks one.
    const card: Promise<ModelCardState> = api
      .modelCard({ lane }, signal)
      .then((found): ModelCardState => ({ status: "card", card: found }))
      .catch((cause: unknown): ModelCardState => {
        if (signal.aborted) {
          // Nobody reads this; the effect has been torn down. Reported as a
          // refusal rather than thrown so the group below is not failed by a
          // cancellation.
          return { status: "refused", code: "UPSTREAM_UNAVAILABLE" };
        }
        return { status: "refused", code: refusalOf(cause) };
      });

    // The lanes' condition is not asked for here: it is one answer for the
    // whole of `/app`, read by `use-serving.ts`, so the chrome badge and this
    // screen's honesty note cannot disagree about whether a model is promoted.
    const observed = Promise.all([
      api.observedReasons({ subsystem, date: settled }, signal),
      card,
    ]).then(([reasons, cardState]): ObservedExplain => ({ reasons, card: cardState }));

    const day = Promise.all([
      api.forecastDayAhead({ subsystem, targetDate, gateProfile }, signal),
      api.diagnosisDayAhead({ subsystem, date: targetDate, gateProfile, locale }, signal),
    ]).then(([forecast, diagnosis]): DiagnosedDay => ({ forecast, diagnosis }));

    observed
      .then(async (settledExplain) => {
        let diagnosed: DiagnosedDay;
        try {
          diagnosed = await day;
        } catch (cause: unknown) {
          settle({
            status: "observedOnly",
            observed: settledExplain,
            code: refusalOf(cause),
          });
          return;
        }
        settle({ status: "explained", observed: settledExplain, day: diagnosed });
      })
      .catch((cause: unknown) => {
        settle({ status: "refused", code: refusalOf(cause) });
      });

    // Handled inside the chain above, but only on a later tick — see the same
    // note in `use-network.ts`. A refused diagnosis is every load today, and it
    // may not log as an unhandled rejection.
    day.catch(() => undefined);

    return () => controller.abort();
  }, [subsystem, targetDate, gateProfile, lane, locale]);

  return state;
}
