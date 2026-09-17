/**
 * The settled day, hour by hour, across all four subsystems.
 *
 * ## Why a hook of its own
 *
 * `use-network.ts` reads the hours of the **selected** subsystem, because every
 * panel it feeds is about one region. A map that animates has to paint four at
 * once, so it needs a different shape of the same data: not one series but a
 * matrix, hour by region.
 *
 * Four reads rather than one, because `/v1/curtailment/hours` takes a subsystem
 * and there is no all-subsystems form. They are cheap — settled rows, a shared
 * cache, no model anywhere near them — and they resolve together so the matrix
 * is whole or absent. A map painted from three regions and a gap would draw the
 * fourth as quiet, which is a claim rather than a gap.
 */

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { civilDayOf, observedHours } from "@/lib/network";

/** One hour of the day, across the four. */
export interface DayHour {
  /** Local hour, 0–23, in Brasília. */
  hourLocal: number;
  /** Settled constrained-off energy that hour, MWh, per subsystem. */
  mwh: Record<string, number>;
  /** The four summed — the national figure for this hour. */
  totalMwh: number;
}

export type DayMatrix =
  | { readonly status: "reading" }
  | {
      readonly status: "read";
      readonly hours: DayHour[];
      /** The largest single-subsystem hour, for a shared colour scale. */
      readonly peakMwh: number;
      readonly date: string;
    }
  | { readonly status: "refused" };

/**
 * How far back to look for a settled day.
 *
 * ONS publishes the hourly record a day or more behind, and "or more" is the
 * operative half: the lag is not a constant. A screen that assumed exactly two
 * days would show an empty scene on any day the publisher ran late, and an
 * empty scene is indistinguishable from a quiet grid.
 */
const LOOKBACK_DAYS = 6;

export function useDayMatrix(targetDate: string): DayMatrix {
  const [state, setState] = useState<DayMatrix>({ status: "reading" });

  useEffect(() => {
    const controller = new AbortController();
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    setState({ status: "reading" });

    /*
      Two UTC days and an exclusive `to`, the window `use-network.ts` explains:
      a Brasília civil day straddles two UTC days, and `from === to` is an empty
      range the gateway refuses with `BAD_INPUT`.
    */
    const from = shiftDays(targetDate, -LOOKBACK_DAYS);

    Promise.all(
      SUBSYSTEM_DISPLAY_ORDER.map((subsystem) =>
        api
          .curtailmentHours(
            { subsystem, from, to: shiftDays(targetDate, 1) },
            controller.signal,
          )
          .then((answer) => [subsystem, answer] as const),
      ),
    )
      .then((pairs) => {
        if (controller.signal.aborted) {
          return;
        }
        /*
          **The latest day that actually has rows**, rather than a day computed
          from the clock and hoped for. The publisher's lag is not a constant,
          and a console that asked for exactly two days back would draw an empty
          scene every time ONS ran late — which reads as a quiet grid rather
          than as a missing publication.
        */
        const days = new Set<string>();
        for (const [, answer] of pairs) {
          for (const row of answer.rows) {
            days.add(civilDayOf(row.validTime));
          }
        }
        const date = [...days].sort().at(-1);
        if (date === undefined) {
          setState({ status: "read", hours: [], peakMwh: 0, date: targetDate });
          return;
        }

        const byHour = new Map<number, DayHour>();
        for (const [subsystem, answer] of pairs) {
          for (const row of observedHours(answer, date)) {
            const found = byHour.get(row.hourLocal) ?? {
              hourLocal: row.hourLocal,
              mwh: {},
              totalMwh: 0,
            };
            found.mwh[subsystem] = row.constrainedOffMwh;
            found.totalMwh += row.constrainedOffMwh;
            byHour.set(row.hourLocal, found);
          }
        }
        const hours = [...byHour.values()].sort((a, b) => a.hourLocal - b.hourLocal);
        /*
          The scale is the largest **single-subsystem hour**, not the largest
          national one. Colouring against the national total would make every
          region pale on a day one of them carried — the comparison this map
          exists for is between regions, so it is drawn on their own range.
        */
        const peakMwh = hours.reduce(
          (max, hour) => Math.max(max, ...Object.values(hour.mwh), 0),
          0,
        );
        setState({ status: "read", hours, peakMwh, date });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: "refused" });
        }
      });

    return () => controller.abort();
  }, [targetDate]);

  return state;
}

/** `YYYY-MM-DD` plus `days`, via UTC so the arithmetic carries no zone. */
function shiftDays(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}
