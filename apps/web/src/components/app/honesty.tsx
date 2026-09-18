/**
 * The labelling that has to travel with every number on these screens.
 *
 * Honesty about data vintage is a product value here, not a nicety, and the
 * domain model makes `VintageFidelity` product-visible by decision. These are
 * the components that discharge that obligation, kept together so it is easy
 * to check that a screen used them.
 */

import { producerLabel } from "@wattsteer/core";
import { Badge, ClockIcon, radius, space, usePalette } from "@wattsteer/ui";
import { createContext, type ReactNode, useContext } from "react";
import { Platform, Text, View } from "react-native";
import { useServing } from "@/components/app/use-serving";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import type {
  ForecastOrigin,
  MitigationStep,
  ReplayIntegrity,
  VintageFidelity,
} from "@/lib/fixtures";

/**
 * Every surface that shows a forecast must name its `ForecastOrigin`. This is
 * that surface, and it also carries the threshold, because every episode and
 * KPI figure on the screen is a function of it.
 *
 * It names **two** artifacts. The producer of a curtailment forecast is
 * WattSteer and `runLabel` is its artifact version; the weather run the
 * forecast consumed is a different fact about a different artifact, so
 * `docs/specs/api-surface.md` puts `weather_run_label` beside the origin
 * rather than making a screen choose which of the two to call "the run". An
 * origin that is not a WattSteer forecast has no weather run to name, so the
 * clause is omitted rather than left dangling.
 */
export function ForecastStamp({
  origin,
  thresholdMw,
}: {
  origin: ForecastOrigin;
  thresholdMw?: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        // The row shrinks as well as its `Text`. Shrinking only the child is
        // not enough: this box sizes to content first, so the child is never
        // asked to give anything up.
        flexShrink: 1,
      }}
    >
      <ClockIcon size={13} color={colors.inkFaint} />
      {/*
        `flexShrink: 1`, because react-native-web defaults it to **0** where CSS
        defaults it to 1. Without it this line sizes to its content and never
        wraps: measured at 400px, the forecast stamp ran to 609px inside a 360px
        column and the remainder was clipped — and the remainder is the weather
        run, which is half of what the stamp exists to name.
      */}
      <Text style={{ fontSize: 11, color: colors.inkFaint, flexShrink: 1 }}>
        {fill(copy.app.stamp.published, {
          producer: producerLabel[origin.producer],
          run: origin.runLabel,
          // Brasília time, whatever clock the reader is on: a grid hour is a
          // Brazilian hour, and the `BRT` in the string says which one.
          when: f.dateTime(origin.publishedAt),
        })}
        {origin.weatherRunLabel === undefined
          ? ""
          : fill(copy.app.stamp.weatherRun, { run: origin.weatherRunLabel })}
        {thresholdMw === undefined
          ? ""
          : fill(copy.app.stamp.threshold, { mw: f.number(thresholdMw) })}
      </Text>
    </View>
  );
}

/**
 * `integrity.provenance` — how a replayed day was held out of the model that
 * forecast it.
 *
 * Deliberately **not** a warning tone, and deliberately a sibling of
 * `VintageBadge` rather than merged into it. `docs/specs/replay.md` refuses to
 * replay a day no artifact held out, so there is no in-sample case left to
 * warn about; and the two axes are the model's information set and the data's,
 * neither derived from the other. They coincide today, which is precisely the
 * argument for keeping them apart: `fold_holdout` + `point_in_time` becomes
 * populated the moment F6 freezes, and a merged badge would then be wrong with
 * no edit having been made.
 */
export function ProvenanceBadge({
  provenance,
}: {
  provenance: ReplayIntegrity["provenance"];
}) {
  const copy = useCopy();
  return (
    <Badge
      label={copy.app.replay.provenance[provenance]}
      tone={provenance === "served" ? "accent" : "info"}
    />
  );
}

export function VintageBadge({ fidelity }: { fidelity: VintageFidelity }) {
  const copy = useCopy();
  return (
    <Badge
      label={copy.app.vintage[fidelity]}
      tone={fidelity === "point_in_time" ? "accent" : "warning"}
    />
  );
}

/**
 * A block that says what a number is *not*. Deliberately not dismissable and
 * deliberately not a tooltip: a caveat behind an interaction is a caveat
 * nobody reads, and these ones change what the number means.
 */
export function HonestyNote({
  title,
  points,
  tone = "warning",
  right,
}: {
  title: string;
  points: string[];
  tone?: "warning" | "neutral";
  right?: ReactNode;
}) {
  const colors = usePalette();
  const accent = tone === "warning" ? colors.warning : colors.borderStrong;
  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        borderLeftWidth: 3,
        borderLeftColor: accent,
        backgroundColor: colors.surfaceSunken,
        padding: space.lg,
        gap: space.sm,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        {/*
          `flexShrink: 1` and a basis, per ADR-0001: react-native-web defaults
          `flexShrink` to 0 where CSS defaults it to 1, so this title sat at its
          content width and pushed the badges beside it past the card. Measured
          at 320px on the Time Machine — "O que esta reexecução é, e o que ela
          não é" beside two badges, 294px of content in a 244px box.
        */}
        <Text
          style={{
            fontSize: 13,
            fontWeight: "700",
            color: colors.ink,
            flexShrink: 1,
            flexBasis: 180,
            flexGrow: 1,
          }}
        >
          {title}
        </Text>
        {right}
      </View>
      {points.map((point) => (
        // The dash must not shrink and the sentence must; without the pair the
        // row sits at the sentence's unwrapped width. Same default, same ADR.
        <View key={point} style={{ flexDirection: "row", gap: 8, flexShrink: 1 }}>
          <Text style={{ fontSize: 12, color: colors.inkFaint, flexShrink: 0 }}>—</Text>
          <Text
            style={{
              fontSize: 12,
              lineHeight: 19,
              color: colors.inkMuted,
              flex: 1,
              /*
                These sentences quote identifiers, and an identifier does not
                wrap: `dessem_free_v1__gate_late__thr5/2025-10-01T…Z` is one
                unbreakable 45-character word, ~250px at this size, in a 244px
                card at 320. `flex: 1` cannot help — there is no space to break
                at. The browser is told it may break inside the word.
              */
              ...(Platform.OS === "web"
                ? ({ overflowWrap: "anywhere", wordBreak: "break-word" } as object)
                : null),
            }}
          >
            {point}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * What a solved plan was optimised against: the resolved forecast origin and
 * the threshold in force.
 *
 * A sibling of {@link ForecastStamp} rather than a use of it, because an
 * `OptimizationResult` names its origin as the **instant the run published**
 * and not as a whole `ForecastOrigin` — the producer and the run label belong
 * to the forecast route, and inventing them here would be this screen forming
 * an opinion about a run it never read.
 *
 * It replaces the prototype's heuristic caveat, which said the numbers came
 * from a greedy pass in the browser. They come from the MILP now, and the
 * honest label is the one that says which forecast it was pointed at.
 */
export function SolveStamp({
  forecastOrigin,
  thresholdMw,
}: {
  forecastOrigin: string;
  thresholdMw: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        // The row shrinks as well as its `Text`. Shrinking only the child is
        // not enough: this box sizes to content first, so the child is never
        // asked to give anything up.
        flexShrink: 1,
      }}
    >
      <ClockIcon size={13} color={colors.inkFaint} />
      {/*
        `flexShrink: 1`, because react-native-web defaults it to **0** where CSS
        defaults it to 1. Without it this line sizes to its content and never
        wraps: measured at 400px, the forecast stamp ran to 609px inside a 360px
        column and the remainder was clipped — and the remainder is the weather
        run, which is half of what the stamp exists to name.
      */}
      <Text style={{ fontSize: 11, color: colors.inkFaint, flexShrink: 1 }}>
        {fill(copy.app.stamp.optimisedAgainst, { when: f.dateTime(forecastOrigin) })}
        {fill(copy.app.stamp.threshold, { mw: f.number(thresholdMw) })}
      </Text>
    </View>
  );
}

/**
 * The mark that says a figure is **settled**, not forecast — when that is a
 * distinction the screen is actually making.
 *
 * The counterpart of {@link ForecastStamp}, and it was over-applied. The rule
 * it was written for is a *mixed* screen: once a model is promoted the Overview
 * draws forecast panels beside observed ones, and then a reader needs to know
 * which is which on every panel. That rule was implemented unconditionally, so
 * on a deployment with nothing promoted — which production has been for weeks —
 * every panel is observed and the badge appeared **eleven times on one screen**:
 * once on the national panel, once on the map, once on the selected region,
 * once per subsystem row, and again on each settled panel.
 *
 * Eleven identical badges do not distinguish anything. They repeat, in a chip,
 * what the lede has already said in a sentence: *"Todo número aqui é medido;
 * nenhum é previsão, porque nenhum modelo está promovido."* A mark that is on
 * everything carries the same information as a mark that is on nothing, and it
 * costs a row of visual noise on every panel to say it.
 *
 * So it is gated on the question the badge is actually for: **is there a
 * forecast on this screen to be told apart from?**
 *
 * That gate used to read a global fact — whether any lane was serving — and a
 * lane promoting somewhere is not a forecast appearing here. The two came apart
 * the day a model was promoted: `gate_early` started serving, `anyLaneServing`
 * flipped, and all seven badges returned to screens still drawing nothing but
 * settled data, because the date in question had no published forecast. The
 * screen was in `observedOnly` — every panel observed, nothing to confuse — and
 * it wore seven chips saying so. The ambiguity is local; the gate now is too.
 *
 * A screen states it with {@link ForecastPresence}. Where none does, the old
 * serving rule still answers: a screen that has not said whether it draws a
 * forecast is not one to silently drop the distinction on.
 *
 * `info` tone, which is the cyan the observed map's ramp is drawn in and which
 * nothing else on these screens uses. The badge and the map are then one
 * statement rather than two: cyan means measured.
 */
const ForecastOnScreen = createContext<boolean | null>(null);

/**
 * A screen stating whether it is drawing a forecast at all, for the badges
 * below it.
 *
 * `null` — no provider — is not `false`. It means nobody has said, and the
 * badge falls back to the serving rule rather than assuming the safe-looking
 * answer: dropping the mark off a screen that *is* mixed is the failure worth
 * avoiding, and it is the opposite of the one being fixed here.
 */
export function ForecastPresence({
  present,
  children,
}: {
  present: boolean;
  children: ReactNode;
}) {
  return (
    <ForecastOnScreen.Provider value={present}>{children}</ForecastOnScreen.Provider>
  );
}

/**
 * Whether this deployment can say *"because no model is promoted"*.
 *
 * Two different facts make a screen observed-only, and they are owed two
 * different sentences. A deployment with nothing promoted has no forecast for
 * any day, and that is the state production ran in for weeks. A deployment that
 * is serving still has no forecast for a day whose gate has not struck —
 * `FORECAST_NOT_YET_PUBLISHED`, which is the ordinary state of tomorrow every
 * evening, and nothing is wrong with it.
 *
 * The screens hard-coded the first sentence. The morning `gate_early` was
 * promoted, `/app` carried "nenhum modelo está promovido" above a lane that
 * was promoted and usable — measured on production, with `/v1/meta` saying
 * `state: promoted, usable: true` while the line said otherwise.
 *
 * Nothing on the screen can infer this from its own refusal:
 * `apps/api/src/api/forecast.ts` resolves from Postgres, has no view of the
 * artifact volume, and `apps/api/test/forecast-day-ahead.test.ts` asserts it
 * never answers `MODEL_UNAVAILABLE`. `/v1/meta` is the only read that knows,
 * and {@link useServing} is the one copy of it.
 *
 * `false` while that read is in flight or failed, which is the safe direction:
 * the fallback sentence claims only what the refusal itself proves.
 */
export function useNoModelPromoted(): boolean {
  const serving = useServing();
  return serving.status === "known" && !serving.serving;
}

/**
 * The ordem de corte, marked as checked rather than asserted in prose.
 *
 * A specialist review asked the prescriptive plan to respect NT DOP 0022
 * §5.1.2's cut order — hydro without spill, thermal outside merit, hydro with
 * spill, renewables — and the honest answer is that WattSteer schedules no
 * generator and so never touches the first three. That answer is worth nothing
 * to a reviewer who cannot see it checked, which is why the optimizer publishes
 * the check on every plan (`conformity` on `OptimizationResult`) and this badge
 * carries it onto the screen.
 *
 * It states the rule and the rung acted on, not a passing grade: the service
 * refuses a plan that fails, so a rendered plan is a passing one by
 * construction and a green tick would be decoration. `null` renders nothing —
 * "no action" schedules nothing and has nothing to check, and a mark over an
 * empty plan would be the same misreading as an avoidability of zero over one.
 */
export function ConformityBadge({
  conformity,
}: {
  conformity: MitigationStep["conformity"];
}) {
  const copy = useCopy();
  if (conformity === null || conformity.hoursChecked === 0) {
    return null;
  }
  return (
    <Badge
      label={fill(copy.app.mitigate.conformityBadge, { rule: conformity.rule })}
      tone="violet"
    />
  );
}

export function ObservedBadge() {
  const copy = useCopy();
  const serving = useServing();
  const onScreen = useContext(ForecastOnScreen);
  const contrasts = onScreen ?? !(serving.status === "known" && !serving.serving);
  if (!contrasts) {
    return null;
  }
  return <Badge label={copy.app.observed.badge} tone="info" />;
}

/**
 * The screen-level counterpart of {@link ForecastStamp}: what the observed
 * panels are reading, and how far behind it is.
 *
 * It occupies the same slot in the screen header the forecast stamp does, so
 * the first thing a reader meets is a line naming which of the two claims the
 * screen is making — before any number is reached. Same instant, same BRT
 * clock, same typography; the difference is the claim, which is the only
 * difference there should be.
 */
export function ObservedStamp({
  latestSettledHour,
  lagHours,
}: {
  latestSettledHour: string;
  lagHours: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        // The row shrinks as well as its `Text`. Shrinking only the child is
        // not enough: this box sizes to content first, so the child is never
        // asked to give anything up.
        flexShrink: 1,
      }}
    >
      <ClockIcon size={13} color={colors.inkFaint} />
      {/*
        `flexShrink: 1`, because react-native-web defaults it to **0** where CSS
        defaults it to 1. Without it this line sizes to its content and never
        wraps: measured at 400px, the forecast stamp ran to 609px inside a 360px
        column and the remainder was clipped — and the remainder is the weather
        run, which is half of what the stamp exists to name.
      */}
      <Text style={{ fontSize: 11, color: colors.inkFaint, flexShrink: 1 }}>
        {fill(copy.app.observed.stamp, {
          when: f.dateTime(latestSettledHour),
          lag: f.number(lagHours),
        })}
      </Text>
    </View>
  );
}
