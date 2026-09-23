/**
 * Which model, which data, which instant — every identity behind the day.
 *
 * The rows are the replay's own provenance: the artifact that produced the
 * forecast and the two windows it was fitted on (re-checked against its card
 * every time the day is read), the pinned origin, the settled data's version,
 * and the solver that built the plan. Then the change log, off the timeline:
 * each instant the day's record moved, oldest first.
 *
 * It names no "active" model. The model serving today is `/v1/meta`'s fact and
 * is on the chrome; this panel is about the artifact that produced *this*
 * day's forecast, which for a held-out day is deliberately not the one serving.
 * And it prints no ONS "data version", because ONS publishes none — the version
 * here is WattSteer's `data_version`, which moves when ONS restates a value.
 */

import type { Replay, ReplayTimeline } from "@wattsteer/core/api";
import { HashIcon, Panel, PanelHeader, space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import type { ReviewState } from "@/components/app/use-replay-review";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { eventLabel } from "@/i18n/time-machine";

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        justifyContent: "space-between",
        gap: space.sm,
        paddingVertical: 5,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Text style={{ fontSize: 12, color: colors.inkMuted, flexShrink: 1 }}>{label}</Text>
      <View style={{ alignItems: "flex-end", flexShrink: 1, minWidth: 0 }}>
        <Text
          selectable={true}
          style={{
            fontSize: 12,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
            color: colors.ink,
            textAlign: "right",
          }}
        >
          {value}
        </Text>
        {note === undefined ? null : (
          <Text style={{ fontSize: 10, color: colors.warning }}>{note}</Text>
        )}
      </View>
    </View>
  );
}

export function TraceabilityPanel({
  replay,
  timeline,
}: {
  replay: Replay;
  timeline: ReviewState<ReplayTimeline>;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.timeMachine.trace;
  const heldOut = replay.integrity.heldOutBy;
  const origin = replay.forecastOrigin;
  const gate =
    timeline.status === "read"
      ? timeline.value.gates.find(
          (one) => one.forecastOrigin?.runLabel === origin.runLabel,
        )
      : undefined;
  const settled = timeline.status === "read" ? timeline.value.settled : null;
  const events = timeline.status === "read" ? timeline.value.events : [];
  const window = (range: readonly string[]) =>
    fill(text.window, { from: f.date(range[0] ?? ""), to: f.date(range[1] ?? "") });

  return (
    <Panel
      style={{ gap: space.md, flexGrow: 1, flexShrink: 1, flexBasis: 320, minWidth: 0 }}
    >
      <PanelHeader
        icon={<HashIcon size={18} color={colors.inkMuted} />}
        title={text.title}
        subtitle={text.subtitle}
      />
      <View>
        <Row label={text.artifact} value={origin.runLabel} />
        {heldOut === undefined || heldOut === null ? null : (
          <>
            <Row label={text.fold} value={heldOut.fold} />
            <Row label={text.trainWindow} value={window(heldOut.trainWindow)} />
            <Row
              label={text.calibrationWindow}
              value={window(heldOut.calibrationWindow)}
            />
          </>
        )}
        <Row
          label={text.published}
          value={f.dateTime(origin.publishedAt)}
          note={
            origin.originKind === "backfilled_holdout"
              ? text.publishedCounterfactual
              : undefined
          }
        />
        {gate?.writtenAt === null || gate?.writtenAt === undefined ? null : (
          <Row label={text.written} value={f.dateTime(gate.writtenAt)} />
        )}
        <Row label={text.settledVersion} value={replay.actual.dataVersion} />
        {settled?.earliestWrittenAt === null ||
        settled?.earliestWrittenAt === undefined ? null : (
          <Row
            label={text.settledWritten}
            value={f.dateTime(settled.earliestWrittenAt)}
          />
        )}
        {settled === null ? null : (
          <Row label={text.restated} value={f.number(settled.restatedRows)} />
        )}
        <Row
          label={text.solver}
          value={`${replay.solver.backend} · ${replay.solver.status}`}
        />
      </View>

      <Text style={{ fontSize: 13, fontWeight: "700", color: colors.ink }}>
        {copy.app.timeMachine.timeline.eventsTitle}
      </Text>
      {events.length === 0 ? (
        <Text style={{ fontSize: 12, color: colors.inkMuted }}>
          {copy.app.timeMachine.timeline.eventsEmpty}
        </Text>
      ) : (
        <View style={{ gap: 6 }}>
          {events.map((event) => (
            <View
              key={`${event.kind}-${event.at}-${event.gateProfile ?? ""}`}
              style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}
            >
              <View
                style={{
                  marginTop: 5,
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor:
                    event.kind === "settled_restated"
                      ? colors.warning
                      : event.kind.startsWith("settled")
                        ? colors.ink
                        : colors.violet,
                }}
              />
              <Text
                style={{
                  width: 116,
                  fontSize: 11,
                  fontVariant: ["tabular-nums"],
                  color: colors.inkMuted,
                }}
              >
                {f.dateTime(event.at)}
              </Text>
              <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, color: colors.ink }}>
                {eventLabel(event, copy, f)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </Panel>
  );
}
