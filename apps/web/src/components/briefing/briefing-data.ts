/**
 * What the scenes are allowed to draw, and where it comes from.
 *
 * **The briefing never fetches.** Every field here is handed down from the
 * screen underneath, which already read it through `ApiClient`. Two reasons,
 * and the second is the important one:
 *
 *  1. A briefing that fetched its own copy could disagree with the screen a
 *     reader dismisses back onto — the same question answered twice, differently,
 *     seconds apart.
 *  2. It makes the safety property structural rather than argued. A scene
 *     cannot show a forecast the product does not have, because there is no
 *     forecast in this object when the product does not have one. `compose.ts`
 *     decides which scenes exist; this decides what they can possibly contain.
 *
 * Every field is nullable and every scene must cope with `null` by rendering
 * the honest thing — usually less, never a placeholder.
 */

import type { Band } from "@wattsteer/core";
import type { ObservedReason } from "@wattsteer/core/api";
import type { MapPaint } from "@/components/charts/subsystem-map";
import type {
  AttributedDriver,
  CurtailmentHourForecast,
  CurtailmentHourObservation,
} from "@/lib/fixtures";

export interface BriefingData {
  /** The four regions, painted as whichever claim the screen is making. */
  readonly paint: MapPaint | null;
  /** The selected subsystem's forecast hours, for the fan. */
  readonly forecastHours: readonly CurtailmentHourForecast[] | null;
  /** Stamped on every published number, and drawn as the fan's floor line. */
  readonly thresholdMw: number | null;
  /** The settled day, for the observed profile. */
  readonly observedHours: readonly CurtailmentHourObservation[] | null;
  /** SHAP attribution, already merged into display groups upstream. */
  readonly drivers: readonly AttributedDriver[] | null;
  /** The day's energy and the hourly peak — two units, deliberately separate. */
  readonly dayEnergy: Band | null;
  readonly peakPower: Band | null;
  /** What the ONS registered, at reporting-entity grain. */
  readonly reasons: readonly ObservedReason[] | null;
}

/** A briefing with nothing behind it. Every scene must survive this. */
export const NO_BRIEFING_DATA: BriefingData = {
  paint: null,
  forecastHours: null,
  thresholdMw: null,
  observedHours: null,
  drivers: null,
  dayEnergy: null,
  peakPower: null,
  reasons: null,
};
