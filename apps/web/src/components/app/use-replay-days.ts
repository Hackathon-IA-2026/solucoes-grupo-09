/**
 * The days the picker may offer, read once from the gateway.
 *
 * ## What this replaced, and why
 *
 * It used to probe four hand-written dates (`REPLAY_DAYS`) with up to eight
 * `POST /v1/replay` calls — optimizer runs whose results were discarded — and
 * its own header said why: `GET /v1/replay/days` is the endpoint that should
 * answer this, and against production it answered 503 `OPTIMIZER_TIMEOUT`.
 *
 * That timeout had a cause. The calendar's observed read filtered on
 * `(valid_time at time zone 'America/Sao_Paulo')::date`, which no index covers,
 * so Postgres read the whole curtailment table: 10.5 s for four months, on a
 * 5 s budget. With the predicate written as a range over `valid_time` the same
 * four months take 1.7 s, and the endpoint answers.
 *
 * So this is now one request, no scenario and no solver, and the picker offers
 * every day the deployment can actually show — 81 of them on the event's
 * instance, against the four this file used to name. `REPLAY_DAYS` stays as
 * what the screen lands on and what the tests pin.
 *
 * ## What it still costs
 *
 * One request per subsystem on mount, answered from the gateway's calendar
 * cache on every later mount (the route sends an ETag keyed on the featured
 * computation). The window is a page size, not a claim — see
 * `lib/replay-days.ts`.
 */

import type { SubsystemCode } from "@wattsteer/core";
import { useEffect, useState } from "react";
import type { ReplayCandidateDay } from "@/lib/fixtures";
import { REPLAY_LANE } from "@/lib/replay";
import { readReplayDays, windowStart } from "@/lib/replay-days";

export type ReplayDaysState =
  | { readonly status: "probing" }
  | {
      readonly status: "known";
      /** Newest first, as the gateway ordered them. */
      readonly viewable: readonly ReplayCandidateDay[];
    };

export function useReplayDays(subsystem: SubsystemCode): ReplayDaysState {
  const [state, setState] = useState<ReplayDaysState>({ status: "probing" });

  useEffect(() => {
    const controller = new AbortController();
    readReplayDays(
      { subsystem, lane: REPLAY_LANE, from: windowStart(new Date()) },
      controller.signal,
    )
      .then((days) => {
        if (controller.signal.aborted) {
          return;
        }
        /*
          A refusal and an empty calendar are the same answer here, and the
          answer is a list the picker states in words: "no day in this window
          can be shown". Leaving the state on `probing` was worse — the picker
          showed one pill forever and never said why, which is a blank standing
          in for a refusal.
        */
        setState({ status: "known", viewable: days ?? [] });
      })
      .catch(() => {
        if (controller.signal.aborted) {
          // Torn down by a navigation. Reporting anything would be reporting
          // about a screen nobody is looking at.
          return;
        }
        setState({ status: "known", viewable: [] });
      });
    return () => controller.abort();
  }, [subsystem]);

  return state;
}
