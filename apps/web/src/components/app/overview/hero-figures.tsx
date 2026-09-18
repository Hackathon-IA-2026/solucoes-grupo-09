/**
 * Everything the Overview's hero computes before it lays anything out.
 *
 * ## Why this is not in the component
 *
 * `OverviewHero` measured 82 on Biome's cognitive-complexity rule, and after
 * three panels had been split out of it, 37. The panels were never the problem:
 * the branching is here, in a dozen derivations that each fork on whether a
 * forecast was published and on which scope the map is in. A component that
 * computes twelve things and then arranges five is doing two jobs, and the
 * arrangement is the one a reader opens the file for.
 *
 * So the calculation has a name. Nothing below decides how anything *looks*;
 * everything below decides what is true, which is why it is a plain function of
 * its inputs and testable without a renderer.
 *
 * ## The rule that shapes all of it
 *
 * A forecast row and a settled row answer the same question in different
 * vocabularies — a risk class is a model's opinion, a megawatt-hour is a
 * measurement — and nothing here ever converts one into the other. Where the
 * forecast half is absent the fields it would have filled are `null`, and the
 * screen states the absence rather than substituting the observed value.
 */

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core";
import type { Band, RiskClass } from "@wattsteer/core/api";
import type { ReactNode } from "react";
import type { Scope } from "@/components/app/map/scope-bar";
import type { ForecastNetwork, ObservedNetwork } from "@/components/app/use-network";
import { RiskChip } from "@/components/charts/risk-class";
import type { MapPaint } from "@/components/charts/subsystem-map";
import type { Formatters } from "@/i18n/format";
import { type CriticalWindow, criticalWindow } from "@/lib/critical-window";
import type { DominantReason } from "@/lib/dominant-reason";
import { roundProbability, type SubsystemCode, subsystemMeta } from "@/lib/fixtures";
import {
  forecastHours,
  forecastRow,
  type OutlookRow,
  observedDay,
  observedRows,
  outlookRows,
} from "@/lib/network";

/** One row of the region rail, reduced to what it draws. */
export interface HeroRegion {
  readonly code: string;
  readonly subsystem: SubsystemCode;
  readonly name: string;
  readonly value: number;
  readonly chip: ReactNode;
  readonly note: string | undefined;
}

/**
 * The five operator questions, answered from settled data.
 *
 * The cards were built against a forecast and rendered only where one existed,
 * so on every day before its gate strikes — which is every evening, and which
 * is the state production sits in for fifteen hours a day — the row vanished
 * and the screen lost its spine.
 *
 * Four of the five never needed a model. How much was curtailed, in which hour,
 * where, and for which ONS reason are all *measurements*, and this screen
 * already draws every one of them in the panels below. Only "vai cortar?" is a
 * claim about the future, and settled data answers the question it becomes:
 * **cortou?**
 *
 * What does not carry over is the vocabulary. There is no risk class here, no
 * probability and no band, because a measurement has none — `observed-overview`
 * holds that line, and every field below is a number ONS published or a count
 * of them.
 */
export interface SettledAnswers {
  /** Whether the subject curtailed at all. Measured, not estimated. */
  readonly cut: boolean;
  readonly totalMwh: number;
  /**
   * Whose figure `totalMwh` is: the four subsystems over the last 24 hours, or
   * the selected region's settled day.
   *
   * The scope decides, exactly as it decides the headline panel's subject — so
   * the card and the panel above it can never show two numbers for one label.
   */
  readonly national: boolean;
  /** The day's largest settled hour, for the selected region. */
  readonly peakHour: ReturnType<typeof observedDay>["peakHour"];
  /** Named on the card, because the hour is one region's even in the overall scope. */
  readonly peakSubsystem: SubsystemCode;
  /** Every region that settled any curtailment — the answer to "onde?". */
  readonly where: readonly SubsystemCode[];
}

export interface HeroFigures {
  readonly day: ReturnType<typeof observedDay>;
  readonly paint: MapPaint;
  readonly regions: HeroRegion[];
  readonly largest: number;
  readonly selectedRow: OutlookRow | null;
  readonly leaderRow: OutlookRow | null;
  readonly atRisk: OutlookRow[];
  readonly magnitudeMwh: number | null;
  readonly magnitudeBand: Band | null;
  readonly riskRow: OutlookRow | null;
  readonly spokenReasons: DominantReason[];
  readonly window: CriticalWindow | null;
  readonly worstRisk: RiskClass;
  /** `null` where a forecast was published and the cards answer from it. */
  readonly settled: SettledAnswers | null;
}

export function heroFigures({
  observed,
  forecast,
  scope,
  f,
}: {
  observed: ObservedNetwork;
  forecast: ForecastNetwork | null;
  scope: Scope;
  /**
   * Passed in rather than read from a hook, so this stays a plain function of
   * its inputs. The rail's rows carry a formatted probability beside the figure
   * — see `region-rail.tsx` — and that string is the one piece of presentation
   * this module has no way to avoid producing, because the chip beside it is a
   * component and the two must agree.
   */
  f: Formatters;
}): HeroFigures {
  const day = observedDay(observed.hours);

  /*
    The map's paint and the rail's rows come from the same read, which is what
    keeps them from disagreeing. `outlookRows` where a forecast exists,
    `observedRows` where it does not — the same union the Overview draws, and
    the same reason: a settled megawatt-hour and a modelled risk class are not
    two renderings of one fact.
  */
  const paint = forecast
    ? ({ kind: "forecast", rows: outlookRows(forecast.outlook) } as const)
    : ({
        kind: "observed",
        rows: observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER),
      } as const);

  const regions = forecast
    ? outlookRows(forecast.outlook).map((row) => ({
        code: subsystemMeta(row.subsystem).short,
        subsystem: row.subsystem,
        name: subsystemMeta(row.subsystem).onsDisplayName,
        value: row.dayExpectedMwh,
        chip: <RiskChip probability={row.occurrenceProbability} compact={true} />,
        note: `≈${f.percentPoints(roundProbability(row.occurrenceProbability))}`,
      }))
    : observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER).map((row) => ({
        code: subsystemMeta(row.subsystem).short,
        subsystem: row.subsystem,
        name: row.onsDisplayName,
        value: row.last24hMwh,
        chip: undefined,
        note: undefined,
      }));

  const largest = Math.max(...regions.map((row) => row.value), 1e-6);
  const selectedRow = forecast === null ? null : forecastRow(forecast.forecast);

  /*
    The region leading the day — the answer to "where?". Not an average of four
    and not a national row: there is no national band, because quantiles do not
    add, and the only thing an operator can act on is the region carrying the
    day.
  */
  const leaderRow =
    forecast === null
      ? null
      : outlookRows(forecast.outlook).reduce((worst, row) =>
          row.dailyEnergy.p50 > worst.dailyEnergy.p50 ? row : worst,
        );

  /*
    **"Onde?" is not always one place, and the worst place is not the biggest.**

    This derived the day's risk from `leaderRow`, which is the region with the
    largest `dailyEnergy.p50`. Those are two different axes: `riskClass` comes
    from `dayOccurrenceProbability` and the energy band from the magnitude head,
    and `SubsystemOutlook` carries them as independent fields. So on any day
    where the region carrying the most energy is not the region most likely to
    curtail, the headline card understated the grid — `Elevado` over a day with
    a `Alto` subsystem on it, and an "Onde?" that named the elevated regions and
    omitted the one at highest risk. A card that reports less risk than the
    gateway published is the worst failure this screen can have.

    So the worst bin is found by *rank*, and `atRisk` is every region in it.
    `leaderRow` keeps its own job — the largest median, which is what "Quanto?"
    is about — and the two are no longer allowed to stand in for each other.
  */
  const RISK_RANK: Record<RiskClass, number> = { low: 0, elevated: 1, high: 2 };
  const rows = forecast === null ? [] : outlookRows(forecast.outlook);
  const worstRisk: RiskClass = rows.reduce<RiskClass>(
    (worst, row) => (RISK_RANK[row.riskClass] > RISK_RANK[worst] ? row.riskClass : worst),
    "low",
  );
  const atRisk = rows.filter((row) => row.riskClass === worstRisk);

  /*
    **"Por quê?" is not always one reason either.**

    ONS splits a day between codes often enough that the second one is worth
    saying when it carries real energy. Below this the card names one: a second
    reason at 4 % is noise, and a card is 168 px.
  */
  /*
    **What "Quanto?" and "Vai cortar?" are about, which the scope decides.**

    Both cards used the selected region unconditionally, which was fine while a
    national block sat above them saying so. With one panel following the scope,
    a card that ignored it would put the region's 226,7k beside the panel's
    275,3k with nothing saying they are different subjects — the exact confusion
    the merge was made to remove.

    In the overall scope the magnitude is the national one the gateway
    publishes, and the risk is the worst bin any subsystem is in: there is no
    national risk class and adding four probabilities would not make one.
  */
  const nationalBand = forecast === null ? null : forecast.outlook.national.band;
  const magnitudeMwh =
    forecast === null || selectedRow === null
      ? null
      : scope === "sin"
        ? (nationalBand?.p50 ?? forecast.outlook.national.expectedMwh)
        : selectedRow.dailyEnergy.p50;
  const magnitudeBand =
    scope === "sin" ? nationalBand : (selectedRow?.dailyEnergy ?? null);
  /*
    Whose risk the first card states. In the overall scope that is a region
    *at* the worst risk, not the one carrying the most energy — the two come
    apart, and reading the leader's class there is what let the headline report
    `Elevado` on a day with a `Alto` subsystem on the board. `atRisk` is sorted
    by `SUBSYSTEM_DISPLAY_ORDER` because `outlookRows` is, so this is stable
    rather than whichever the gateway happened to send first.
  */
  const riskRow = scope === "sin" ? (atRisk[0] ?? leaderRow) : selectedRow;

  const SECOND_REASON_SHARE = 0.15;
  const spokenReasons = observed.reasons
    .slice(0, 2)
    .filter((entry, index) => index === 0 || entry.share >= SECOND_REASON_SHARE);

  /*
    The hours to act in. `null` where no hour of the day is more likely to
    curtail than not, which is an answer and not a gap — the card simply does
    not claim a window it does not have.
  */
  const window =
    forecast === null ? null : criticalWindow(forecastHours(forecast.forecast));

  /*
    The day's magnitude, in its own component. Three branches — a settled day,
    the four subsystems, one region — each with its own figure, note and split;
    see `headline-panel.tsx`.
  */
  /*
    The same five questions, answered from what settled. `null` where a
    forecast exists, because then the cards read it and this would be a second
    answer to one question.

    The subject follows the scope the way `HeadlinePanel` does: `SIN Geral` is
    the national row the gateway publishes — `derived: sum_of_four`, a sum of
    measurements and not a quantile — and `Por Região` is the selected region's
    settled day. The largest hour is the region's either way and the card says
    so, because `observed.hours` is one subsystem's and inventing a national
    peak from four would be inventing it.
  */
  const settled: SettledAnswers | null =
    forecast === null
      ? (() => {
          const totalMwh =
            scope === "sin"
              ? observed.now.national.last24hConstrainedOffMwh
              : day.totalMwh;
          return {
            cut: totalMwh > 0,
            totalMwh,
            national: scope === "sin",
            peakHour: day.peakHour,
            peakSubsystem: observed.subsystem as SubsystemCode,
            where: observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER)
              .filter((row) => row.last24hMwh > 0)
              .map((row) => row.subsystem),
          };
        })()
      : null;

  return {
    day,
    settled,
    paint,
    regions,
    largest,
    selectedRow,
    leaderRow,
    atRisk,
    magnitudeMwh,
    magnitudeBand,
    riskRow,
    spokenReasons,
    window,
    worstRisk,
  };
}
