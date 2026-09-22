/**
 * The day's magnitude, whose subject the scope names.
 *
 * Split out of `overview-hero.tsx` for the reason `question-row.tsx` was: the
 * panel branches three ways — a settled day, the four subsystems, one region —
 * and each branch carries its own figure, note and split. Inside the hero those
 * branches sat beside four other panels' worth of the same, and the function
 * measured 82 on Biome's complexity rule.
 *
 * `NationalFigureBlock` is reused rather than reimplemented for the overall
 * scope: it already draws the difference between a published joint band and an
 * expectation with a stated reason, and a second place deciding that is a second
 * place to get it wrong.
 */

import type { GridOutlook } from "@wattsteer/core/api";
import { Panel, space, type, usePalette } from "@wattsteer/ui";
import { Text } from "react-native";
import { BandTriple, PanelTitle, RailFact } from "@/components/app/figures/rail-panels";
import type { CoverageState } from "@/components/app/figures/use-coverage";
import type { LadderState } from "@/components/app/figures/use-ladder";
import type { Scope } from "@/components/app/map/scope-bar";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { subsystemMeta } from "@/lib/fixtures";
import type { OutlookRow } from "@/lib/network";
import { NationalFigureBlock } from "./national-panel";
import { HeroStat } from "./region-rail";

export function HeadlinePanel({
  scope,
  selectedRow,
  outlook,
  observedTotalMwh,
  coverage,
  ladder,
  text,
}: {
  scope: Scope;
  /** `null` where no forecast was published: the panel states the settled day. */
  selectedRow: OutlookRow | null;
  outlook: GridOutlook | null;
  observedTotalMwh: number;
  coverage: CoverageState;
  /** The measured gain over the mandatory baseline, on one fold. */
  ladder: LadderState;
  /** The Overview's own locale strings, already chosen. */
  text: {
    totalLabel: string;
    totalNoteObserved: string;
    totalNoteForecast: string;
    noBand: string;
  };
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();

  return (
    <Panel style={{ gap: space.lg }}>
      {/*
        **The three quantiles, named, and the coverage under them.**

        This was one large number with a band strip below it, which says what the
        median is and leaves the edges to be read off a bar. The interval is the
        product's claim, so all three are printed — and the fraction of settled
        days that actually landed inside the band goes with them, because an
        interval without its measured coverage is a promise with no record.
      */}
      {selectedRow === null ? (
        <>
          <HeroStat
            label={text.totalLabel}
            value={observedTotalMwh}
            unit="MWh"
            note={text.totalNoteObserved}
          />
          <Text style={{ ...type.caption, color: colors.inkFaint }}>{text.noBand}</Text>
        </>
      ) : scope === "sin" && outlook !== null ? (
        <NationalFigureBlock national={outlook.national} />
      ) : (
        <>
          <PanelTitle
            title={text.totalLabel}
            note={`${subsystemMeta(selectedRow.subsystem).onsDisplayName} · ${
              text.totalNoteForecast
            }`}
          />
          <BandTriple band={selectedRow.dailyEnergy} />
        </>
      )}

      {/*
        The coverage is the gate's, measured over a held-out fold for this
        lane — so it describes the band whichever subject the band is about, and
        sits outside the branch rather than being repeated inside each one.
      */}
      {outlook !== null && coverage.status === "read" ? (
        <RailFact
          label={copy.app.grid.coverageLabel}
          value={f.percent(coverage.coverage.dayTotal, 0)}
          note={fill(copy.app.grid.coverageNote, {
            days: f.number(coverage.coverage.days),
            target: f.percent(coverage.coverage.target, 0),
          })}
        />
      ) : null}
      {/*
        The other half of the same claim, from the same card: what the served
        rung adds over the baseline an operator would use without it. Coverage
        says the interval is honest; this says the model is worth having. Both
        are `absent` rather than zero where the card withheld them — see
        `use-ladder.ts` — and both are gated on there being a forecast on the
        screen at all, because neither describes a settled day.
      */}
      {outlook !== null && ladder.status === "read" ? (
        <RailFact
          label={copy.app.grid.ladderLabel}
          value={`${ladder.ladder.delta > 0 ? "+" : ""}${f.percentPoints(
            ladder.ladder.delta,
          )}`}
          note={`${fill(copy.app.grid.ladderNote, {
            model: f.percent(ladder.ladder.model, 0),
            baseline: f.percent(ladder.ladder.baseline, 0),
            fold: ladder.ladder.foldId,
            rows: f.number(ladder.ladder.rows),
          })}${
            ladder.ladder.maeMwh === null
              ? ""
              : ` · ${fill(copy.app.grid.ladderMae, {
                  mae: f.compact(ladder.ladder.maeMwh),
                })}`
          }`}
        />
      ) : null}
      {/*
        **The division is in the rail, and it used to be here.**

        The bars moved here first, out of a standalone card that was stating the
        same total under the same sentence. They have moved once more, for the
        same reason one step further out: this card draws the *selected* region,
        and so did the bars, while the rail beside the map draws all four with
        no split on any of them. The division is a property of every region, not
        of the one that happens to be selected, and it is drawn on all four now.
        See `region-rail.tsx`.
      */}
      {/*
        **The window and the cause are the cards' now, at the top of the screen.**

        They were added here first, and then the operator brief's five questions
        moved onto this screen as a row of cards — which say the same two things
        in the same words, above the fold. Two answers to one question is how a
        reader learns to distrust both, so this panel keeps what the cards
        summarise (the figure, its band and the fleet split) and stops repeating
        what they state.
      */}
    </Panel>
  );
}
