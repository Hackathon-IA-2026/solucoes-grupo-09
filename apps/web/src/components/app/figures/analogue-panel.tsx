/**
 * The analogue: a real day the grid already lived through, and what settled.
 *
 * ## The one piece of evidence here that does not need the model to be right
 *
 * Every other panel in Explicar is about the forecast — its drivers, its
 * reliability curve, the ONS reasons behind the day it is about. All of them
 * are worth more the more a reader already trusts the model. This one is not:
 * it names **dates**, and a reader who was on shift that day remembers it,
 * while one who was not can look it up in ONS's archive with no access to this
 * product at all.
 *
 * ## What it must never become
 *
 * The neighbours' settled totals sit beside the forecast and are never combined
 * with it — no average of the three, no adjusted band, no blend. The moment a
 * neighbour's outcome enters a published number this stops being evidence and
 * becomes a second, unpromoted model. The panel therefore prints them as a
 * list of days and their outcomes, with no total and no summary statistic.
 *
 * ## The distance, and why it is shown at all
 *
 * Unitless and comparable only within one answer: the scale is the pool's own
 * spread, so a 0.8 here and a 0.8 in tomorrow's answer are not the same claim.
 * It is shown because the alternative — three dates in an order with nothing
 * saying how close any of them is — invites a reader to treat the third as
 * being as relevant as the first.
 */

import { Panel, space, type, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import type { SimilarDaysState } from "@/components/app/figures/use-similar-days";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { PanelTitle, RailFact } from "./rail-panels";

export function AnaloguePanel({ state }: { state: SimilarDaysState }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.analogue;

  if (state.status !== "read") {
    return (
      <Panel style={{ gap: space.md }}>
        <PanelTitle title={text.title} note={text.subtitle} />
        <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 18 }}>
          {state.status === "reading" ? text.reading : text.absent}
        </Text>
      </Panel>
    );
  }

  const { days } = state;

  return (
    <Panel style={{ gap: space.md }}>
      <PanelTitle title={text.title} note={text.subtitle} />

      {days.neighbours.map((day) => (
        <RailFact
          key={day.targetDate}
          label={f.date(day.targetDate)}
          value={`${f.compact(day.observedConstrainedOffMwh)} MWh`}
          note={fill(text.distance, { distance: day.distance.toFixed(2) })}
        />
      ))}

      <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 17 }}>
        {fill(text.note, {
          days: f.number(days.poolDays),
          from: f.date(days.poolFrom),
        })}
      </Text>
      <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 17 }}>
        {text.caveat}
      </Text>
    </Panel>
  );
}
