/**
 * One scene, drawn.
 *
 * Every case here wraps a component the product already has. That is the whole
 * economy of this feature: a briefing is the screens' own panels, sequenced, so
 * a reader who watches one and then opens the screen is looking at the same
 * drawing rather than at a presentation *about* the screen.
 *
 * **No scene fetches, and no scene computes.** Each is handed a slice of
 * `BriefingData` — what the screen underneath already read — and draws it or
 * draws less. A scene with nothing to show renders its heading and stops; it
 * never renders a placeholder, because "coming soon" in front of an operator
 * mid-answer is worse than a sequence that moves on.
 */

import { Badge, space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { HonestyNote } from "@/components/app/honesty";
import type { BriefingData } from "@/components/briefing/briefing-data";
import { BandFigure } from "@/components/charts/band-figure";
import { CompareBars } from "@/components/charts/compare-bars";
import { DriverBars } from "@/components/charts/driver-bars";
import { FanChart } from "@/components/charts/fan-chart";
import { ObservedProfile } from "@/components/charts/observed-profile";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { useCopy } from "@/i18n";
import { subsystemMeta } from "@/lib/fixtures";
import type { Scene } from "@/lib/voice/briefing/types";

export interface SceneProps {
  readonly scene: Scene;
  readonly data: BriefingData;
}

/** The small muted line every scene opens with, so a reader knows what they are looking at. */
function SceneLabel({ children }: { children: string }) {
  const colors = usePalette();
  return (
    <Text style={{ fontSize: 13, fontWeight: "600", color: colors.inkMuted }}>
      {children}
    </Text>
  );
}

function TitleScene({ scene }: { scene: Extract<Scene, { type: "title" }> }) {
  const colors = usePalette();
  const copy = useCopy();
  const meta = scene.subsystem === null ? null : subsystemMeta(scene.subsystem);
  return (
    <View style={{ gap: space.sm, alignItems: "center" }}>
      <SceneLabel>{copy.briefing.scenes.title}</SceneLabel>
      <Text
        accessibilityRole="header"
        style={{
          fontSize: 34,
          lineHeight: 40,
          fontWeight: "600",
          letterSpacing: -0.8,
          textAlign: "center",
          color: colors.ink,
        }}
      >
        {meta?.onsDisplayName ?? copy.briefing.label}
      </Text>
    </View>
  );
}

function MapFocusScene({
  scene,
  data,
}: {
  scene: Extract<Scene, { type: "map_focus" }>;
  data: BriefingData;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const meta = subsystemMeta(scene.subsystem);
  return (
    <View style={{ gap: space.md, alignItems: "center" }}>
      <SceneLabel>{copy.briefing.scenes.mapFocus}</SceneLabel>
      {data.paint === null ? (
        // No rows to paint. The region still gets named, because "where" is the
        // one thing this scene is for and the name answers it without a map.
        <Text style={{ fontSize: 28, fontWeight: "600", color: colors.ink }}>
          {meta.onsDisplayName}
        </Text>
      ) : (
        <SubsystemMap
          paint={data.paint}
          selected={scene.subsystem}
          hovered={scene.subsystem}
          onSelect={() => {}}
        />
      )}
    </View>
  );
}

function ForecastCurveScene({ data }: { data: BriefingData }) {
  const copy = useCopy();
  if (data.forecastHours === null || data.thresholdMw === null) {
    return <SceneLabel>{copy.briefing.scenes.forecastCurve}</SceneLabel>;
  }
  return (
    <View style={{ gap: space.md }}>
      <SceneLabel>{copy.briefing.scenes.forecastCurve}</SceneLabel>
      <FanChart hours={[...data.forecastHours]} thresholdMw={data.thresholdMw} />
    </View>
  );
}

function ObservedCurveScene({ data }: { data: BriefingData }) {
  const copy = useCopy();
  if (data.observedHours === null) {
    return <SceneLabel>{copy.briefing.scenes.observedCurve}</SceneLabel>;
  }
  return (
    <View style={{ gap: space.md }}>
      <SceneLabel>{copy.briefing.scenes.observedCurve}</SceneLabel>
      <ObservedProfile
        hours={data.observedHours}
        emptyLabel={copy.app.overview.settledDayEmpty}
      />
    </View>
  );
}

/**
 * One headline band.
 *
 * The two figures are kept apart by unit rather than merged into a row: energy
 * is MWh over a day and peak is MW inside an hour, and a briefing that stacked
 * them would be inviting the reader to compare them.
 */
function KpiScene({
  scene,
  data,
}: {
  scene: Extract<Scene, { type: "kpi" }>;
  data: BriefingData;
}) {
  const copy = useCopy();
  const energy = scene.figure === "day_energy";
  const band = energy ? data.dayEnergy : data.peakPower;
  const label = energy ? copy.app.explain.magnitude : copy.app.explain.peakPower;
  if (band === null) {
    return <SceneLabel>{label}</SceneLabel>;
  }
  return <BandFigure label={label} band={band} unit={energy ? "MWh" : "MW"} />;
}

function CauseScene({ data }: { data: BriefingData }) {
  const copy = useCopy();
  if (data.drivers === null) {
    return <SceneLabel>{copy.app.explain.driversTitle}</SceneLabel>;
  }
  return (
    <View style={{ gap: space.md }}>
      <SceneLabel>{copy.app.explain.driversTitle}</SceneLabel>
      <DriverBars drivers={data.drivers} />
    </View>
  );
}

/**
 * What the ONS registered, by code.
 *
 * Codes, not prose: `REL`, `CNF`, `ENE`, `PAR` are the identifiers the operator
 * publishes, and the product's vocabulary rule is that the gloss is a `t()` key
 * rather than a translated string off the wire. An empty list is a fact — the
 * ONS registered no restriction — so it says so instead of hiding the scene.
 */
function ConstraintScene({ data }: { data: BriefingData }) {
  const colors = usePalette();
  const copy = useCopy();
  const codes = [...new Set((data.reasons ?? []).map((row) => row.reason))];
  return (
    <View style={{ gap: space.md }}>
      <SceneLabel>{copy.briefing.scenes.constraint}</SceneLabel>
      {codes.length === 0 ? (
        <Text style={{ fontSize: 14, color: colors.inkMuted }}>
          {copy.app.explain.reasonsEmpty}
        </Text>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {codes.map((code) => (
            <Badge key={code} label={code} tone="neutral" />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * The two figures the optimizer scored, side by side.
 *
 * `compose.ts` may only build this scene from an `OptimizationResult`, so the
 * numbers arriving here have a solve behind them. The difference between them
 * is deliberately not drawn: the median of a difference is not the difference
 * of medians, and `avoided_energy_mwh` is a field on the answer for that reason.
 */
function CounterfactualScene({
  scene,
}: {
  scene: Extract<Scene, { type: "counterfactual" }>;
}) {
  const copy = useCopy();
  return (
    <View style={{ gap: space.md }}>
      <SceneLabel>{copy.briefing.scenes.counterfactual}</SceneLabel>
      <CompareBars
        rows={[
          {
            key: "baseline",
            label: copy.app.mitigate.steps.no_action,
            value: scene.baselineMwh,
            tone: "forecast",
          },
          {
            key: "optimized",
            label: copy.app.mitigate.steps.battery_and_load,
            value: scene.optimizedMwh,
            tone: "recovered",
          },
        ]}
      />
    </View>
  );
}

/**
 * What was planned, beside what happened.
 *
 * The rows are the screen's — Máquina do tempo built them when it re-scored the
 * day — and the scene names only *that* a comparison is shown. With no rows it
 * draws its heading, which is the same rule every other scene follows.
 */
function ComparisonScene({ data }: { data: BriefingData }) {
  const copy = useCopy();
  if (data.comparison === null || data.comparison.length === 0) {
    return <SceneLabel>{copy.briefing.scenes.comparison}</SceneLabel>;
  }
  return (
    <View style={{ gap: space.md }}>
      <SceneLabel>{copy.briefing.scenes.comparison}</SceneLabel>
      <CompareBars rows={[...data.comparison]} />
    </View>
  );
}

function RecommendationScene() {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <View style={{ gap: space.sm }}>
      <SceneLabel>{copy.briefing.scenes.recommendation}</SceneLabel>
      <Text style={{ fontSize: 15, lineHeight: 22, color: colors.ink }}>
        {copy.briefing.recommendationBody}
      </Text>
    </View>
  );
}

/**
 * The reads, at the end.
 *
 * Non-negotiable for this product: a briefing is a claim, and a claim says
 * where it came from. Rendered by the stage rather than here, because the list
 * belongs to the plan and not to any one scene — this scene is its heading.
 */
function SourcesScene() {
  const copy = useCopy();
  return <SceneLabel>{copy.briefing.scenes.sources}</SceneLabel>;
}

function RefusalScene({ scene }: { scene: Extract<Scene, { type: "refusal" }> }) {
  const copy = useCopy();
  return (
    <HonestyNote
      title={copy.briefing.refusalTitle}
      tone="warning"
      points={[copy.error[scene.code] ?? copy.briefing.refusalTitle]}
    />
  );
}

export function SceneRenderer({ scene, data }: SceneProps) {
  switch (scene.type) {
    case "title":
      return <TitleScene scene={scene} />;
    case "map_focus":
      return <MapFocusScene scene={scene} data={data} />;
    case "forecast_curve":
      return <ForecastCurveScene data={data} />;
    case "observed_curve":
      return <ObservedCurveScene data={data} />;
    case "kpi":
      return <KpiScene scene={scene} data={data} />;
    case "cause":
      return <CauseScene data={data} />;
    case "constraint":
      return <ConstraintScene data={data} />;
    case "comparison":
      return <ComparisonScene data={data} />;
    case "counterfactual":
      return <CounterfactualScene scene={scene} />;
    case "recommendation":
      return <RecommendationScene />;
    case "sources":
      return <SourcesScene />;
    case "refusal":
      return <RefusalScene scene={scene} />;
    default:
      // Unreachable: every member of the union has an arm above. Kept so a new
      // scene type is a visible gap here rather than a blank stage.
      return null;
  }
}
