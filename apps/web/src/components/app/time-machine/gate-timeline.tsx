/**
 * The day's record, in the order it was made: the two D−1 gates, then the
 * settled day, then ONS's rewrite of it when there was one.
 *
 * Each gate node carries the instant it names *and* says what kind of instant
 * that is: a served forecast's publication, or — for a reconstruction — the
 * gate it stands in for. The two are not the same fact, and the node that
 * draws the second as the first would be drawing a publication that never
 * happened. There is no intraday node because WattSteer makes no intraday
 * forecast; the panel says so once, under the nodes.
 *
 * Every figure is read: the P50 is the gate's own band, the deviation is the
 * gate's own `deviation_mwh` computed on the server. Nothing here subtracts one
 * gate's median from the other's.
 */

import type { ReplayTimeline } from "@wattsteer/core/api";
import { ClockIcon, Panel, PanelHeader, space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { InfoHint } from "@/components/app/time-machine/info-hint";
import type { ReviewState } from "@/components/app/use-replay-review";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { gateLabel, mwh, signedMwh } from "@/i18n/time-machine";
import { gateEntry } from "@/lib/time-machine";

interface Node {
  key: string;
  dot: string;
  title: string;
  instant: string | null;
  instantNote: string | null;
  figure: string | null;
  note: string | null;
}

export function GateTimeline({ state }: { state: ReviewState<ReplayTimeline> }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.timeMachine.timeline;

  const header = (
    <PanelHeader
      icon={<ClockIcon size={18} color={colors.inkMuted} />}
      title={text.title}
      subtitle={text.subtitle}
      right={<InfoHint label={copy.app.timeMachine.about} points={[text.noIntraday]} />}
    />
  );

  if (state.status !== "read") {
    return (
      <Panel style={{ gap: space.md }}>
        {header}
        <Text style={{ fontSize: 13, color: colors.inkMuted }}>
          {state.status === "refused"
            ? copy.error[state.code]
            : copy.app.timeMachine.refreshing}
        </Text>
      </Panel>
    );
  }

  const timeline = state.value;
  const nodes: Node[] = [];
  for (const profile of ["gate_early", "gate_late"] as const) {
    const gate = gateEntry(timeline, profile);
    const origin = gate?.forecastOrigin ?? null;
    nodes.push({
      key: profile,
      dot: profile === "gate_early" ? colors.violet : colors.accent,
      title: gateLabel(profile, copy),
      instant: origin === null ? null : f.dateTime(origin.publishedAt),
      instantNote:
        gate?.publishedAtIsCounterfactual === true
          ? copy.app.timeMachine.trace.publishedCounterfactual
          : null,
      figure:
        gate?.dayTotal === null || gate?.dayTotal === undefined
          ? null
          : fill(text.bandLine, { p50: mwh(gate.dayTotal.p50, f) }),
      note:
        gate === undefined
          ? null
          : gate.dayTotal === null
            ? gate.dayTotalUnavailableReason === null
              ? null
              : (copy.error[gate.dayTotalUnavailableReason as keyof typeof copy.error] ??
                null)
            : gate.deviationMwh === null
              ? null
              : fill(text.deviationLine, { value: signedMwh(gate.deviationMwh, f) }),
    });
  }
  const settled = timeline.settled;
  nodes.push({
    key: "settled",
    dot: colors.ink,
    title: settled.settledTotalMwh === null ? text.settledNodeAbsent : text.settledNode,
    instant:
      settled.earliestWrittenAt === null ? null : f.dateTime(settled.earliestWrittenAt),
    instantNote: null,
    figure:
      settled.settledTotalMwh === null ? null : `${mwh(settled.settledTotalMwh, f)} MWh`,
    note: null,
  });
  if (settled.restatedRows > 0 && settled.latestWrittenAt !== null) {
    nodes.push({
      key: "restated",
      dot: colors.warning,
      title: fill(text.settledRestatedNode, { rows: f.number(settled.restatedRows) }),
      instant: f.dateTime(settled.latestWrittenAt),
      instantNote: null,
      figure: null,
      note: null,
    });
  }

  return (
    <Panel style={{ gap: space.md, opacity: state.refreshing ? 0.7 : 1 }}>
      {header}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {nodes.map((node, index) => (
          <View
            key={node.key}
            style={{ flexGrow: 1, flexShrink: 1, flexBasis: 130, minWidth: 0, gap: 6 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: node.dot,
                  borderWidth: 2,
                  borderColor: colors.surface,
                }}
              />
              {index < nodes.length - 1 ? (
                <View
                  style={{ flexGrow: 1, height: 2, backgroundColor: colors.border }}
                />
              ) : null}
            </View>
            <Text style={{ fontSize: 13, fontWeight: "700", color: colors.ink }}>
              {node.title}
            </Text>
            {node.instant === null ? null : (
              <Text style={{ fontSize: 12, color: colors.inkMuted }}>{node.instant}</Text>
            )}
            {node.instantNote === null ? null : (
              <Text style={{ fontSize: 11, color: colors.warning }}>
                {node.instantNote}
              </Text>
            )}
            {node.figure === null ? null : (
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                  color: colors.ink,
                }}
              >
                {node.figure}
              </Text>
            )}
            {node.note === null ? null : (
              <Text style={{ fontSize: 11, lineHeight: 16, color: colors.inkMuted }}>
                {node.note}
              </Text>
            )}
          </View>
        ))}
      </View>
    </Panel>
  );
}
