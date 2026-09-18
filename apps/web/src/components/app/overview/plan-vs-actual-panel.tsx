/**
 * ONS's plan for the day, beside what the grid did — and neither is ours.
 *
 * ## Why this panel is not like the others
 *
 * Every other figure on these screens is a WattSteer number with a settled one
 * beside it. This one is **ONS against ONS**: the day-ahead load programme
 * against the settled energy balance, with the product appearing only as the
 * subtraction between them.
 *
 * That is what a reviewer asked for and it is worth having for a reason beyond
 * compliance. A curtailment forecast read against an outcome answers "was the
 * model right?". Read against the *programme* as well, it also answers "was
 * this a hard day?" — because the grid was run towards that programme, and the
 * distance between plan and outcome is the day's own difficulty, measured by
 * the operator rather than by us.
 *
 * ## What it refuses to draw
 *
 * The deviation, unless both series cover the same hours. The programme lands
 * on D−1 and the settlement lands hours after the fact, so for most of a day
 * one side exists and the other does not, and a subtraction over whichever
 * hours overlap would be printed under a label that says "the day". The gateway
 * decides this (`summariseDay`) and names which side is missing; this panel
 * renders that sentence rather than a blank, which is the rule the whole
 * product is built on.
 *
 * The corridors are the other half — programmed interchange against verified —
 * and they are the "estado da interconexão" the operator brief asks for, in the
 * only form ONS publishes it.
 */

import type { GridContext } from "@wattsteer/core/api";
import { Panel, space, type, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { PanelTitle, RailFact } from "@/components/app/figures/rail-panels";
import type { GridContextState } from "@/components/app/use-grid-context";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { type SubsystemCode, subsystemMeta } from "@/lib/fixtures";

/** The corridor's other end, from a link that names both. */
function counterpart(
  link: GridContext["corridors"][number],
  subsystem: SubsystemCode,
): string {
  const other = link.fromSubsystem === subsystem ? link.toSubsystem : link.fromSubsystem;
  return subsystemMeta(other as SubsystemCode).short;
}

export function PlanVsActualPanel({
  state,
  subsystem,
}: {
  state: GridContextState;
  subsystem: SubsystemCode;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.planned;

  if (state.status !== "read") {
    /*
      One sentence in both non-read states, and they are different sentences.
      `reading` says nothing is known yet; `refused` says the gateway did not
      answer, which is the only thing here a reader could act on. Neither
      renders a zero.
    */
    return (
      <Panel style={{ gap: space.md }}>
        <PanelTitle title={text.title} note={text.subtitle} />
        <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 18 }}>
          {state.status === "reading" ? text.reading : text.refused}
        </Text>
      </Panel>
    );
  }

  const { day, corridors } = state.context;
  const deviation = day.deviationMwh;

  return (
    <Panel style={{ gap: space.md }}>
      <PanelTitle title={text.title} note={text.subtitle} />

      <RailFact
        label={text.programmed}
        value={
          day.programmedLoadMwh === null ? "—" : `${f.compact(day.programmedLoadMwh)} MWh`
        }
        note={day.programmedLoadMwh === null ? text.programmedAbsent : undefined}
      />
      <RailFact
        label={text.observed}
        value={
          day.observedLoadMwh === null ? "—" : `${f.compact(day.observedLoadMwh)} MWh`
        }
        note={day.observedLoadMwh === null ? text.observedAbsent : undefined}
      />
      <RailFact
        label={text.deviation}
        value={
          deviation === null
            ? "—"
            : `${deviation > 0 ? "+" : ""}${f.compact(deviation)} MWh`
        }
        // The reason, in the reader's words, where the number would be. The
        // gateway chose it; this maps it and never decides it.
        note={
          deviation === null
            ? text.deviationAbsent[
                day.deviationUnavailableReason ?? "no_programme_published"
              ]
            : fill(text.deviationNote, { hours: String(day.hoursCompared) })
        }
      />

      {corridors.length === 0 ? null : (
        <View style={{ gap: space.sm }}>
          <Text style={{ ...type.caption, color: colors.inkFaint }}>
            {text.corridorsTitle}
          </Text>
          {corridors.map((link) => (
            <RailFact
              key={`${link.fromSubsystem}-${link.toSubsystem}`}
              label={fill(text.corridor, { other: counterpart(link, subsystem) })}
              value={
                link.verifiedMwh === null ? "—" : `${f.compact(link.verifiedMwh)} MWh`
              }
              note={
                link.programmedMwh === null
                  ? text.corridorNoProgramme
                  : fill(text.corridorProgrammed, {
                      mwh: f.compact(link.programmedMwh),
                    })
              }
            />
          ))}
        </View>
      )}

      <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 17 }}>
        {text.note}
      </Text>
    </Panel>
  );
}
