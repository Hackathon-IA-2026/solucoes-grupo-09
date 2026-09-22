/**
 * The evidence beside the replayed day, one kind per tab.
 *
 * Four kinds, and each says what it is evidence *of*:
 *
 * - **What moved the forecast** — the stored attribution of exactly the pinned
 *   publication. It decomposes the model's number, never the settled day and
 *   never the deviation; a publication nobody explained is a sentence, not a
 *   served attribution of another artifact borrowed in its place.
 * - **Similar days** — past days whose D−1 programme looked like this one, and
 *   what settled on them. Dates a reader can check, never blended with the band.
 * - **ONS's stated reason** — the settled classification, by share of energy,
 *   with the ONS document behind it. The reason is ONS's; the product forecasts
 *   how much and never why.
 * - **Audit** — the gateway's own answers, as JSON links.
 *
 * There is no "probable cause" tab and no confidence score for one: the product
 * does not classify a curtailment, and a percentage beside a cause it did not
 * classify would be a number with nothing behind it.
 *
 * The tabs are `Pill`s in the `tab` role inside a `tablist`, and the body is a
 * `tabpanel` — the one place on these screens where a tab does control a panel,
 * which is the promise that role makes.
 */

import type { ReplayAttribution } from "@wattsteer/core/api";
import {
  LinkIcon,
  Panel,
  PanelHeader,
  Pill,
  SearchIcon,
  space,
  usePalette,
} from "@wattsteer/ui";
import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import type { SimilarDaysState } from "@/components/app/figures/use-similar-days";
import type { DayReasons, ReviewState } from "@/components/app/use-replay-review";
import { DriverBars } from "@/components/charts/driver-bars";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { mwh } from "@/i18n/time-machine";
import { rankedReasons } from "@/lib/dominant-reason";
import { attributedDrivers } from "@/lib/explain";
import type { ObservedReason } from "@/lib/fixtures";

type TabKey = "drivers" | "analogues" | "reasons" | "audit";
const TABS: readonly TabKey[] = ["drivers", "analogues", "reasons", "audit"];

export interface AuditLink {
  readonly key: string;
  readonly label: string;
  readonly url: string;
}

function Muted({ children }: { children: string }) {
  const colors = usePalette();
  return (
    <Text style={{ fontSize: 13, lineHeight: 20, color: colors.inkMuted }}>
      {children}
    </Text>
  );
}

function Note({ children }: { children: string }) {
  const colors = usePalette();
  return (
    <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
      {children}
    </Text>
  );
}

function Drivers({ state }: { state: ReviewState<ReplayAttribution> }) {
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.timeMachine.attribution;
  if (state.status === "reading") {
    return <Muted>{copy.app.timeMachine.refreshing}</Muted>;
  }
  if (state.status === "refused") {
    return <Muted>{copy.error[state.code]}</Muted>;
  }
  const { attribution, attributionUnavailableReason } = state.value;
  if (attribution === null) {
    return (
      <Muted>
        {attributionUnavailableReason === null
          ? text.absent.not_published
          : text.absent[attributionUnavailableReason]}
      </Muted>
    );
  }
  return (
    <View style={{ gap: space.md }}>
      <Muted>
        {fill(text.total, {
          day: mwh(attribution.dayExpectedMwh, f),
          baseline: mwh(attribution.baselineExpectedMwh, f),
        })}
      </Muted>
      <DriverBars drivers={attributedDrivers(attribution.drivers)} />
      <Note>{text.note}</Note>
    </View>
  );
}

function Analogues({ state }: { state: SimilarDaysState }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.analogue;
  if (state.status === "reading") {
    return <Muted>{text.reading}</Muted>;
  }
  if (state.status === "absent") {
    return <Muted>{text.absent}</Muted>;
  }
  return (
    <View style={{ gap: space.sm }}>
      <Muted>{text.subtitle}</Muted>
      {state.days.neighbours.map((neighbour) => (
        <View
          key={neighbour.targetDate}
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: space.sm,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
            {f.date(neighbour.targetDate)}
          </Text>
          <Text
            style={{
              fontSize: 14,
              fontWeight: "600",
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {`${mwh(neighbour.observedConstrainedOffMwh, f)} MWh`}
          </Text>
          <Text style={{ fontSize: 11, color: colors.inkFaint, flexBasis: "100%" }}>
            {fill(text.distance, { distance: f.number(neighbour.distance, 2) })}
          </Text>
        </View>
      ))}
      <Note>{text.caveat}</Note>
    </View>
  );
}

function Reasons({ state }: { state: ReviewState<DayReasons> }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.timeMachine.reasons;
  if (state.status === "reading") {
    return <Muted>{copy.app.timeMachine.refreshing}</Muted>;
  }
  if (state.status === "refused") {
    return <Muted>{copy.error[state.code]}</Muted>;
  }
  const ranked = rankedReasons(state.value.reasons.rows as readonly ObservedReason[]);
  const citation = state.value.citation;
  return (
    <View style={{ gap: space.sm }}>
      <Muted>{text.note}</Muted>
      {ranked.length === 0 ? <Muted>{text.empty}</Muted> : null}
      {ranked.map((reason) => (
        <View key={reason.reason} style={{ gap: 4 }}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              gap: space.sm,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "700", color: colors.ink }}>
              {reason.reason}
            </Text>
            <Text style={{ fontSize: 12, color: colors.inkMuted }}>
              {fill(text.share, { share: f.percent(reason.share) })}
            </Text>
          </View>
          <View
            style={{ height: 8, borderRadius: 4, backgroundColor: colors.surfaceSunken }}
          >
            <View
              style={{
                width: `${Math.round(reason.share * 100)}%`,
                height: 8,
                borderRadius: 4,
                backgroundColor: colors.ink,
                opacity: 0.55,
              }}
            />
          </View>
        </View>
      ))}
      {citation === null ? null : (
        <Pressable accessibilityRole="link" onPress={() => Linking.openURL(citation.url)}>
          <Text
            style={{ fontSize: 12, color: colors.info, textDecorationLine: "underline" }}
          >
            {fill(text.citation, {
              document: [citation.documentCode, citation.revision, citation.title]
                .filter((part) => part !== null && part !== "")
                .join(" · "),
            })}
          </Text>
        </Pressable>
      )}
      <Note>{copy.app.explain.reasonLegend}</Note>
    </View>
  );
}

function Audit({ links }: { links: readonly AuditLink[] }) {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <View style={{ gap: space.sm }}>
      <Muted>{copy.app.timeMachine.audit.note}</Muted>
      {links.map((link) => (
        <Pressable
          key={link.key}
          accessibilityRole="link"
          onPress={() => Linking.openURL(link.url)}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <LinkIcon size={14} color={colors.info} />
          <Text
            style={{ fontSize: 13, color: colors.info, textDecorationLine: "underline" }}
          >
            {link.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function EvidenceTabs({
  attribution,
  analogues,
  reasons,
  audit,
}: {
  attribution: ReviewState<ReplayAttribution>;
  analogues: SimilarDaysState;
  reasons: ReviewState<DayReasons>;
  audit: readonly AuditLink[];
}) {
  const colors = usePalette();
  const copy = useCopy();
  const text = copy.app.timeMachine.tabs;
  const [tab, setTab] = useState<TabKey>("drivers");

  return (
    <Panel
      style={{ gap: space.md, flexGrow: 2, flexShrink: 1, flexBasis: 420, minWidth: 0 }}
    >
      <PanelHeader
        icon={<SearchIcon size={18} color={colors.inkMuted} />}
        title={text.label}
        subtitle={
          {
            drivers: copy.app.timeMachine.attribution.title,
            analogues: copy.app.analogue.title,
            reasons: copy.app.timeMachine.reasons.title,
            audit: copy.app.timeMachine.audit.title,
          }[tab]
        }
      />
      <View
        accessibilityRole="tablist"
        style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}
      >
        {TABS.map((key) => (
          <Pill
            key={key}
            label={text[key]}
            size="sm"
            tone="secondary"
            active={tab === key}
            accessibilityRole="tab"
            onPress={() => setTab(key)}
            testID={`time-machine-tab-${key}`}
          />
        ))}
      </View>
      <View accessibilityRole="none" role="tabpanel" style={{ gap: space.md }}>
        {tab === "drivers" ? <Drivers state={attribution} /> : null}
        {tab === "analogues" ? <Analogues state={analogues} /> : null}
        {tab === "reasons" ? <Reasons state={reasons} /> : null}
        {tab === "audit" ? <Audit links={audit} /> : null}
      </View>
    </Panel>
  );
}
