/**
 * The Time Machine dashboard's reads of one replayed day, beyond the replay.
 *
 * Three routes answer what a single `/v1/replay` cannot — how the four
 * subsystems landed (`compare`), what the day looked like at both gates and
 * when each fact arrived (`timeline`), and what moved the forecast being
 * replayed (`attribution`) — plus the day's settled restriction reasons and
 * the ONS document behind them. **Every one of them is a read**: nothing here
 * scores a plan, sums a band or subtracts one quantile from another, and every
 * figure the panels print is a field the gateway sent.
 *
 * ## One shape, three states, and a re-read that keeps the answer
 *
 * `reading` / `read` / `refused`, as every other read on these screens. A
 * re-read — the reader moving to another day or subsystem — keeps the previous
 * answer on screen marked `refreshing` rather than collapsing to a skeleton,
 * for the reason `use-network.ts` states: a panel that shrinks under a reader
 * mid-sentence is worse than one that says it is catching up.
 *
 * `refused` carries the code from the closed enum and nothing else. The panel
 * renders `copy.error[code]`; the envelope's own prose never reaches a screen.
 */

import type { ErrorCode } from "@wattsteer/core";
import type {
  ObservedReasons,
  ReplayAttribution,
  ReplayCompare,
  ReplayTimeline,
} from "@wattsteer/core/api";
import { useEffect, useState } from "react";
import { refusalOf } from "@/lib/absence";
import { api } from "@/lib/api";
import { API_URL } from "@/lib/config";
import { type EvidenceCitation, readEvidence } from "@/lib/evidence";
import type { SubsystemCode } from "@/lib/fixtures";
import { settleWith } from "@/lib/settle";
import { useLatest } from "@/lib/use-latest";

export type ReviewState<T> =
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly value: T; readonly refreshing: boolean }
  | { readonly status: "refused"; readonly code: ErrorCode };

/**
 * One read, keyed on the bytes of its question.
 *
 * The key is the question and the reader is the answer: the effect re-runs
 * when the key moves, and the previous answer stays drawn — marked — until the
 * new one lands or is refused.
 */
function useRead<T>(
  key: string | null,
  read: (signal: AbortSignal) => Promise<T>,
): ReviewState<T> {
  const [state, setState] = useState<ReviewState<T>>({ status: "reading" });
  // Read through a ref, as `use-replay.ts` reads its scenario: the reader is an
  // input to the effect and a new closure every render; the key is the trigger.
  const latest = useLatest(read);

  useEffect(() => {
    if (key === null) {
      return;
    }
    const controller = new AbortController();
    const settle = settleWith(controller.signal, setState);
    // The opening statement of a fetch effect — see `use-explain.ts`.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    setState((previous) =>
      previous.status === "read"
        ? { ...previous, refreshing: true }
        : { status: "reading" },
    );
    latest
      .current(controller.signal)
      .then((value) => settle({ status: "read", value, refreshing: false }))
      .catch((cause: unknown) => settle({ status: "refused", code: refusalOf(cause) }));
    return () => controller.abort();
    // The key is the trigger and `latest` is a ref; see above.
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [key]);

  return state;
}

/** Four subsystems against their pinned bands, for one day and one lane. */
export function useReplayCompare(
  date: string,
  /* `null` while the serving lane is unknown — see `use-replay-lane.ts`. */
  lane: string | null,
): ReviewState<ReplayCompare> {
  return useRead(lane === null ? null : `${date}|${lane}`, (signal) =>
    api.replayCompare({ date, lane: lane ?? "" }, signal),
  );
}

/** One subsystem's day at both served gates, and when each fact arrived. */
export function useReplayTimeline(
  date: string,
  subsystem: SubsystemCode,
): ReviewState<ReplayTimeline> {
  return useRead(`${date}|${subsystem}`, (signal) =>
    api.replayTimeline({ date, subsystem }, signal),
  );
}

/** What moved the replayed forecast, for its pinned publication. */
export function useReplayAttribution(
  date: string,
  subsystem: SubsystemCode,
  /* `null` while the serving lane is unknown — see `use-replay-lane.ts`. */
  lane: string | null,
): ReviewState<ReplayAttribution> {
  return useRead(lane === null ? null : `${date}|${subsystem}|${lane}`, (signal) =>
    api.replayAttribution({ date, subsystem, lane: lane ?? "" }, signal),
  );
}

/**
 * The day's settled restriction reasons, and the ONS document behind them.
 *
 * The replayed day itself, not the "last settled day" the Overview reads: a
 * replay is about a day that has already settled, so the reason ONS stated for
 * it is the one that belongs beside it. The citation is best-effort, exactly
 * as on the Overview — a missing document is `null`, never a refusal of the
 * reasons it would have annotated.
 */
export interface DayReasons {
  readonly reasons: ObservedReasons;
  readonly citation: EvidenceCitation | null;
}

export function useDayReasons(
  date: string,
  subsystem: SubsystemCode,
): ReviewState<DayReasons> {
  return useRead(`${date}|${subsystem}`, async (signal) => {
    const [reasons, citation] = await Promise.all([
      api.observedReasons({ subsystem, date }, signal),
      readEvidence(API_URL, { subsystem, date }, signal).catch(() => null),
    ]);
    return { reasons, citation };
  });
}
