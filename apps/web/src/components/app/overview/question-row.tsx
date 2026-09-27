/**
 * The operator brief's five questions, as a row of cards.
 *
 * Split out of `overview-hero.tsx`, where it had taken that component's
 * cognitive complexity to 82 on Biome's measure — five cards whose every field
 * branches on the scope, the risk row and how many reasons the day had, all
 * inside a function that also assembles four other panels. The branching has
 * not gone anywhere; it has a name and a boundary now, and the hero reads as
 * the five things it lays out rather than as the hundred decisions inside them.
 *
 * Every input arrives derived. This component decides how to *say* an answer
 * and never what the answer is — which is why the scope, the leading region and
 * the spoken reasons are props rather than things it works out from state.
 */

import type { Band, RiskClass } from "@wattsteer/core/api";
import {
  ClockIcon,
  MapIcon,
  PieChartIcon,
  SearchIcon,
  space,
  type,
  usePalette,
  ZapIcon,
} from "@wattsteer/ui";
import { Link } from "expo-router";
import { Platform, Text, View } from "react-native";
import { AnswerFeedback } from "@/components/app/answer-feedback";
import { QuestionCard } from "@/components/app/figures/question-cards";
import type { Scope } from "@/components/app/map/scope-bar";
import { riskColor } from "@/components/charts/risk-color";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import type { CriticalWindow } from "@/lib/critical-window";
import type { DominantReason } from "@/lib/dominant-reason";
import type { EvidenceCitation } from "@/lib/evidence";
import type { SubsystemCode } from "@/lib/fixtures";
import { subsystemMeta } from "@/lib/fixtures";
import type { SettledAnswers } from "./hero-figures";

/** One region's row, reduced to what the cards read off it. */
export interface QuestionSubject {
  readonly subsystem: SubsystemCode;
  readonly riskClass: RiskClass;
  readonly occurrenceProbability: number;
}

export function QuestionRow({
  scope,
  selectedSubsystem,
  risk,
  magnitudeMwh,
  magnitudeBand,
  window,
  reasons,
  reasonDate,
  atRisk,
  worstRisk,
  causeNote,
  onWhy,
  whyOpen,
}: {
  scope: Scope;
  selectedSubsystem: SubsystemCode;
  /** Whose probability and risk class the first card states. */
  risk: QuestionSubject;
  magnitudeMwh: number;
  /** `null` where the gateway published an expectation and no interval. */
  magnitudeBand: Band | null;
  window: CriticalWindow | null;
  /** One or two, already filtered by share. See the hero for the rule. */
  reasons: readonly DominantReason[];
  reasonDate: string;
  /** Every region in the day's worst bin — the answer to "where?". */
  atRisk: readonly QuestionSubject[];
  worstRisk: RiskClass;
  causeNote: string;
  /**
   * Opens and closes the long answer to "Por quê?".
   *
   * The card states the ONS code and its share, which is the whole answer to
   * the question as the operator brief asks it and about a tenth of what
   * Explicar has to say. The screen owns the toggle — see the Overview route —
   * and this component only says which card carries it.
   */
  onWhy?: () => void;
  whyOpen?: boolean;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      <QuestionCard
        icon={<ZapIcon size={14} color={riskColor(colors, risk.riskClass).fg} />}
        question={copy.app.grid.q1}
        answer={copy.app.risk[risk.riskClass]}
        detail={fill(copy.app.grid.q1Detail, {
          probability: f.percent(risk.occurrenceProbability),
          subsystem: subsystemMeta(risk.subsystem).onsDisplayName,
        })}
        tone={riskColor(colors, risk.riskClass).fg}
      />
      <QuestionCard
        icon={<PieChartIcon size={14} color={colors.violet} />}
        question={copy.app.grid.q2}
        answer={f.compact(magnitudeMwh)}
        unit="MWh"
        detail={
          magnitudeBand === null ? copy.app.grid.q2DetailExpected : copy.app.grid.q2Detail
        }
        footnote={
          magnitudeBand === null
            ? undefined
            : `P10 ${f.compact(magnitudeBand.p10)} · P90 ${f.compact(magnitudeBand.p90)}`
        }
      />
      {/*
          The window keeps the Overview's own notation — `0h–5h BRT` — rather
          than a clock range. It is the form the rest of this screen uses and the
          one the operator brief was answered in; the card is a new place for the
          sentence, not a new way of saying it.
        */}
      <QuestionCard
        icon={<ClockIcon size={14} color={colors.info} />}
        question={copy.app.grid.q3}
        answer={
          window === null
            ? copy.app.grid.noWindow
            : fill(copy.app.overview.windowRange, {
                from: String(window.fromHour),
                to: String(window.toHour),
              })
        }
        detail={window === null ? copy.app.overview.windowNone : copy.app.grid.q3Detail}
        footnote={
          window === null
            ? undefined
            : fill(copy.app.overview.windowPeak, {
                peak: String(window.peakHour),
                mwh: f.compact(window.peakMwh),
              })
        }
      />
      <QuestionCard
        icon={<SearchIcon size={14} color={colors.inkMuted} />}
        question={copy.app.grid.q4}
        answer={
          reasons.length === 0
            ? copy.app.grid.noReason
            : reasons.map((entry) => entry.reason).join(" · ")
        }
        detail={
          reasons.length === 0
            ? copy.app.grid.noReasonDetail
            : fill(copy.app.grid.q4Detail, {
                date: f.date(reasonDate),
                share: reasons.map((entry) => f.percent(entry.share, 0)).join(" · "),
              })
        }
        note={causeNote}
        noteId="overview-cause-note"
        onPress={onWhy}
        expanded={whyOpen}
      />
      <QuestionCard
        icon={<MapIcon size={14} color={colors.inkMuted} />}
        question={copy.app.grid.q5}
        /*
            **Short codes, always.**

            The answer line is the card's largest type, and
            `SUDESTE/CENTRO-OESTE` does not fit a fifth of the row at that size —
            it clipped to `SUDESTE/CENT…`, which is a truncation that still reads
            as a name. The codes are what the map writes on each region and what
            the chips beside it say, so a reader matching the three has nothing
            to translate. The full name goes in the detail, which wraps.
          */
        answer={
          scope === "region"
            ? subsystemMeta(selectedSubsystem).short
            : atRisk.map((row) => subsystemMeta(row.subsystem).short).join(" · ")
        }
        detail={
          scope === "region"
            ? fill(copy.app.grid.q5DetailRegion, {
                subsystem: subsystemMeta(selectedSubsystem).onsDisplayName,
              })
            : atRisk.length === 1 && atRisk[0] !== undefined
              ? fill(copy.app.grid.q5DetailOne, {
                  subsystem: subsystemMeta(atRisk[0].subsystem).onsDisplayName,
                  risk: copy.app.risk[worstRisk],
                })
              : fill(copy.app.grid.q5DetailMany, {
                  count: String(atRisk.length),
                  risk: copy.app.risk[worstRisk],
                })
        }
      />

      {/*
          **What is left under the row, and what moved onto a card.**

          The window's scatter stays here: `0h–23h` is the longest *run*, and a
          reader acting on it while nine other hours also qualify is acting on a
          third of the day — that is a correction to the figure above it, not a
          caveat about the product.

          The cause caveat moved into the "Por quê?" card, behind a mark in its
          corner. It is the sentence this product cannot drop — the model
          forecasts how much will be curtailed and never why — but it is a
          standing truth rather than news, and a standing truth printed across
          the page every morning is read once and then never again.

          **The rule citation is gone from this row and kept on the settled
          one.** `Regra: IO-ON.NE.5NE Rev.61, p. 7` was set in the accent
          colour directly under the forecast cards, where it read as a finding
          about the day rather than as what it is: the ONS document behind the
          reason label. On the settled row it has the verdict control under it
          and a reason beside it that was actually measured, which is where a
          reader can do something with it. Here it was a link nobody asked for,
          under numbers it does not describe.
        */}
      <View style={{ flexBasis: "100%", gap: 4 }}>
        {window !== null && window.hoursInDay > window.toHour - window.fromHour + 1 ? (
          <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 17 }}>
            {fill(copy.app.overview.windowScattered, {
              hours: String(window.hoursInDay),
            })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The same five cards, answered from settled data.
 *
 * Beside its forecast sibling on purpose — the two are read together, and this
 * file is where a reviewer can see in one screenful that they never share a
 * word. {@link QuestionRow} states a risk class, a probability and a band;
 * this one states megawatt-hours ONS published and counts of them, and there is
 * no expression in it that could produce a quantile.
 *
 * Why it exists: the row used to render only where a forecast did, so the
 * screen lost its five answers every day until the gate struck — on a page that
 * was in fact full of settled megawatt-hours, four of the five questions
 * answerable from them, and one of them ("por quê?") already reading nothing
 * else.
 */
export function SettledQuestionRow({
  settled,
  reasons,
  reasonDate,
  evidence,
  causeNote,
  onWhy,
  whyOpen,
}: {
  settled: SettledAnswers;
  /** One or two, already filtered by share. Observed either way — see the hero. */
  reasons: readonly DominantReason[];
  reasonDate: string;
  evidence: EvidenceCitation | null;
  causeNote: string;
  onWhy?: () => void;
  whyOpen?: boolean;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const observed = copy.app.observed;
  const peakName = subsystemMeta(settled.peakSubsystem).onsDisplayName;

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      {/*
        `info` — the cyan the observed map is painted in and that the risk
        palette cannot produce. The forecast card tints this icon by risk class;
        there is no class here, so it takes the colour that means measured.
      */}
      <QuestionCard
        icon={<ZapIcon size={14} color={colors.info} />}
        question={observed.q1}
        answer={settled.cut ? observed.q1Yes : observed.q1No}
        detail={
          settled.national
            ? observed.q1DetailNational
            : fill(observed.q1DetailRegion, { subsystem: peakName })
        }
        tone={colors.info}
      />
      <QuestionCard
        icon={<PieChartIcon size={14} color={colors.violet} />}
        question={copy.app.grid.q2}
        answer={f.compact(settled.totalMwh)}
        unit="MWh"
        detail={
          settled.national
            ? observed.q2DetailNational
            : fill(observed.q2DetailRegion, { subsystem: peakName })
        }
      />
      {/*
        No critical window: that is a run of hours a model called more likely to
        curtail than not, and there is no model. The settled counterpart is the
        hour that actually curtailed most, which the profile panel below already
        names — one figure, two places, and they read it from the same `day`.
      */}
      <QuestionCard
        icon={<ClockIcon size={14} color={colors.info} />}
        question={copy.app.grid.q3}
        answer={
          settled.peakHour === null ? observed.q3None : f.hour(settled.peakHour.hourLocal)
        }
        detail={
          settled.peakHour === null
            ? fill(observed.q3NoneDetail, {
                subsystem: peakName,
                date: f.date(reasonDate),
              })
            : fill(observed.q3Detail, { subsystem: peakName, date: f.date(reasonDate) })
        }
        footnote={
          settled.peakHour === null
            ? undefined
            : `${f.compact(settled.peakHour.constrainedOffMwh)} MWh`
        }
      />
      {/*
        Unchanged from the forecast row, because it was never a forecast card:
        the ONS reason and its share are read off the settled day in both
        states. It is the one question this screen could always answer.
      */}
      <QuestionCard
        icon={<SearchIcon size={14} color={colors.inkMuted} />}
        question={copy.app.grid.q4}
        answer={
          reasons.length === 0
            ? copy.app.grid.noReason
            : reasons.map((entry) => entry.reason).join(" · ")
        }
        detail={
          reasons.length === 0
            ? copy.app.grid.noReasonDetail
            : fill(copy.app.grid.q4Detail, {
                date: f.date(reasonDate),
                share: reasons.map((entry) => f.percent(entry.share, 0)).join(" · "),
              })
        }
        note={causeNote}
        noteId="overview-cause-note"
        onPress={onWhy}
        expanded={whyOpen}
      />
      {/* Short codes, for the reason the forecast card gives above. */}
      <QuestionCard
        icon={<MapIcon size={14} color={colors.inkMuted} />}
        question={copy.app.grid.q5}
        answer={
          settled.where.length === 0
            ? observed.q5None
            : settled.where.map((code) => subsystemMeta(code).short).join(" · ")
        }
        detail={
          settled.where.length === 0
            ? observed.q5DetailNone
            : settled.where.length === 1 && settled.where[0] !== undefined
              ? fill(observed.q5DetailOne, {
                  subsystem: subsystemMeta(settled.where[0]).onsDisplayName,
                })
              : fill(observed.q5DetailMany, { count: String(settled.where.length) })
        }
      />

      {evidence === null ? null : (
        <View style={{ flexBasis: "100%" }}>
          <Link
            href={evidence.url as never}
            target="_blank"
            style={{
              ...type.caption,
              color: colors.accent,
              ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
            }}
          >
            {fill(
              evidence.page === null
                ? copy.app.overview.causeEvidenceNoPage
                : copy.app.overview.causeEvidence,
              {
                document: evidence.documentCode,
                revision: evidence.revision ?? "",
                page: String(evidence.page ?? ""),
              },
            )}
          </Link>
          {/*
            Under the citation, not under the card: the verdict is about the
            passage the corpus chose, which is the answer a reader can be wrong
            about. The figures above it are measurements, and there is nothing
            to disagree with in a measurement.
          */}
          <AnswerFeedback
            surface="evidence"
            subject={{
              documentCode: evidence.documentCode,
              ...(evidence.page === null ? {} : { documentPage: evidence.page }),
              targetDate: reasonDate,
            }}
            testID="evidence-feedback"
          />
        </View>
      )}
    </View>
  );
}
