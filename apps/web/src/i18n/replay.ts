/**
 * A replayed day, said in the reader's language and notation.
 *
 * Split out of `app/app/replay.tsx` for the reason `./drivers.ts` and
 * `./narration.ts` were split out of the Explain screen: these are the
 * decisions worth testing — which branch of the provenance statement a
 * `held_out_by` of `null` takes, whether an unmeasured revision premium prints
 * the word or a zero, which of the contract's fields the comparison rows read —
 * and none of them needs a React tree to be true.
 *
 * The cost of their living in the screen was paid by the suite.
 * `replay-screen.test.ts` could only reach them as **source text**: the rule
 * "the provenance statement and the vintage statement are two, never merged"
 * was `expect(screen).toContain("provenanceNote")`, which passes whatever the
 * function returns, and "the denominator is the day, not the episode" was a
 * slice of the file between two `function` keywords. The rules are values now;
 * the greps that stood in for them are gone.
 *
 * Everything here is at the edge, by rule. `GET /v1/replay` sends codes, dates
 * and numbers; the words and the digit grouping are chosen here, once, per
 * locale. **Nothing here computes a figure** — the screen's header says why,
 * and `test/one-execution-rule.test.ts` enforces it repository-wide.
 */

import type { Replay } from "@wattsteer/core/api";
import type { CompareRow } from "@/components/charts/compare-bars";
import {
  INGESTION_GO_LIVE,
  type ReplayCandidateDay,
  subsystemMeta,
} from "@/lib/fixtures";
import type { Copy } from "./copy.en";
import { type Formatters, fill } from "./format";

/** The parts the caveat's two lists are drawn from, as the copy map spells them. */
export type VintagePart = keyof Copy["app"]["replay"]["vintagePart"];

/**
 * A replayed day's name: the date in the reader's convention, then the ONS
 * subsystem.
 *
 * No technology. The picker offers a date and a subsystem, and the forecast
 * behind a replayed day has one head per subsystem — a technology in this label
 * would be a division the model does not make, printed as if it did.
 */
export function dayLabel(day: ReplayCandidateDay, copy: Copy, f: Formatters): string {
  return fill(copy.app.replay.dayLabel, {
    date: f.date(day.date),
    subsystem: subsystemMeta(day.subsystem).onsDisplayName,
  });
}

/**
 * The provenance sentence: which artifact produced this forecast, and what it
 * was fitted on.
 *
 * Two branches, and neither is a warning. A `served` day's forecast was
 * published before the day began, which is the strongest statement available
 * and needs no fold to make it — `held_out_by` is `null` there, and that is the
 * contract's own shape rather than a missing value. A `fold_holdout` day names
 * its fold, the fold's artifact and **both** recorded windows: the training
 * block and the calibration window, because the calibration window is where
 * the isotonic fit and the two conformal scalars were fitted, so a day inside
 * it would have shaped the interval this screen promises a floor from.
 *
 * There is no third branch. The prototype had one — `IN-SAMPLE` — and it is
 * gone rather than disabled: under `docs/specs/replay.md` a day no artifact
 * held out is refused, so the branch is unreachable by construction and dead
 * code that says otherwise is a claim the product does not make.
 */
export function provenanceNote(replay: Replay, copy: Copy, f: Formatters): string {
  const heldOut = replay.integrity.heldOutBy;
  if (heldOut === null) {
    return fill(copy.app.replay.provenanceServedNote, {
      published: f.dateTime(replay.forecastOrigin.publishedAt),
    });
  }
  return fill(copy.app.replay.provenanceFoldHoldoutNote, {
    fold: heldOut.fold,
    artifact: heldOut.artifactId,
    trainFrom: f.date(heldOut.trainWindow[0]),
    trainTo: f.date(heldOut.trainWindow[1]),
    calibrationFrom: f.date(heldOut.calibrationWindow[0]),
    calibrationTo: f.date(heldOut.calibrationWindow[1]),
  });
}

/**
 * The two sentences a `revision_optimistic` day owes a reader: *what* the
 * caveat touches, and *how big* it is.
 *
 * Both are read off the response rather than written here. The parts come from
 * `integrity.vintage_affects` / `vintage_exempt` and this function only spells
 * them, so a part the service stops claiming stops being named on screen; and
 * the size is `revision_premium_recovered_mwh`, which is `null` until ONS has
 * restated days held in both vintages. `null` renders as the word
 * **unmeasured** — never as a zero, and never as silence, because a caveat
 * whose size is not stated reads as a caveat that is small.
 *
 * Nothing is emitted for a `point_in_time` day: there is no restatement to
 * bound, and a sentence saying so would make the honest case look qualified.
 */
export function vintageExtent(integrity: Replay["integrity"], copy: Copy): string[] {
  if (integrity.vintageFidelity !== "revision_optimistic") {
    return [];
  }
  const spell = (parts: readonly string[]): string =>
    parts
      .map((part) => copy.app.replay.vintagePart[part as VintagePart] ?? part)
      .join(", ");
  return [
    fill(copy.app.replay.vintageExtentNote, {
      affects: spell(integrity.vintageAffects),
      exempt: spell(integrity.vintageExempt),
    }),
    integrity.revisionPremiumRecoveredMwh === null
      ? copy.app.replay.revisionPremiumUnmeasured
      : fill(copy.app.replay.revisionPremiumMeasured, {
          mwh: integrity.revisionPremiumRecoveredMwh,
        }),
  ];
}

/** The vintage sentence proper, on either side of go-live. */
export function vintageNote(
  fidelity: Replay["vintageFidelity"],
  copy: Copy,
  f: Formatters,
): string {
  return fill(
    fidelity === "revision_optimistic"
      ? copy.app.replay.revisionOptimisticNote
      : copy.app.replay.pointInTimeNote,
    { goLive: f.date(INGESTION_GO_LIVE) },
  );
}

/**
 * What was forecast, what happened and what a plan would have left — one list,
 * built once.
 *
 * Extracted so the screen and the briefing read the *same* rows. Two builders
 * for one comparison is two things to drift, and a briefing quoting different
 * figures from the screen it overlays is the worst version of that.
 */
export function compareRows(replay: Replay, copy: Copy, f: Formatters): CompareRow[] {
  const episode = replay.episodes[0];
  const rows: CompareRow[] = [
    {
      key: "actual",
      label: copy.app.replay.rowActual,
      // `actual.total_mwh`: the whole local day. An episode is the run of hours
      // above the threshold, so using it here would make the headline share
      // move when the threshold moves — the reduction would look better simply
      // for having drawn the episode more tightly.
      value: replay.actual.totalMwh,
      tone: "actual",
      note:
        episode === undefined
          ? undefined
          : fill(copy.app.replay.rowActualNote, {
              hours: f.number(episode.durationHours),
              mw: f.number(episode.thresholdMw),
              peak: f.number(replay.actual.peakMw),
            }),
    },
    {
      key: "forecast",
      label: copy.app.replay.rowForecast,
      // `forecast.day_total` off the payload, not the componentwise sum of the
      // hourly ones. Quantiles are not additive: adding 24 P90s assumes every
      // hour lands at its 90th percentile together, which describes a day far
      // worse than a 90th-percentile day. The forecaster emits a path ensemble
      // precisely so the joint total exists on the contract, and
      // `test/no-summed-bands.test.ts` is the standing guard that no web code
      // path rebuilds it.
      band: replay.forecast.dayTotal,
      tone: "forecast",
      note: copy.app.replay.rowForecastNote,
    },
    {
      key: "remaining",
      label: copy.app.replay.rowRemaining,
      value: replay.optimizedCurtailmentMwh,
      tone: "recovered",
      note: copy.app.replay.rowRemainingNote,
    },
  ];
  return rows;
}
