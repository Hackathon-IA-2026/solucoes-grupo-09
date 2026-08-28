/**
 * The `/app` chrome: one header, one context bar, four screens.
 *
 * Navigation is a flat four-way switch rather than a hierarchy, because the
 * screens are four questions about the same selection ("what will happen",
 * "why", "what could we do", "what would it have been worth") and none of them
 * is a child of another. The context bar sits *below* the screen switch and
 * above the content, so it reads as "these four screens, on this selection" —
 * and because the selection lives in the URL, switching screens keeps it.
 *
 * Mobile behaviour: the screen switch and the selector rows scroll
 * horizontally rather than wrapping or collapsing into a menu. The same code
 * ships to iOS and Android, and a hamburger that hides which subsystem is on
 * screen would be worse on a phone than a scroll.
 */

import {
  focusRing,
  layout,
  Pill,
  radius,
  space,
  usePalette,
  WattSteerMark,
} from "@wattsteer/ui";
import { router, usePathname } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import {
  RUN_LABELS,
  type RunLabel,
  SUBSYSTEMS,
  type SubsystemCode,
  type Technology,
} from "@/lib/fixtures";
import { sharedParams, useAppParams } from "./use-app-params";

interface ScreenDef {
  key: string;
  label: string;
  short: string;
  path: string;
}

const SCREENS: ScreenDef[] = [
  { key: "overview", label: "Grid Overview", short: "Overview", path: "/app" },
  { key: "explain", label: "Explain", short: "Explain", path: "/app/explain" },
  { key: "mitigate", label: "Mitigate", short: "Mitigate", path: "/app/mitigate" },
  { key: "replay", label: "Time Machine", short: "Replay", path: "/app/replay" },
];

export function AppShell({
  children,
  showSelection = true,
}: {
  children: ReactNode;
  showSelection?: boolean;
}) {
  const colors = usePalette();
  const pathname = usePathname();
  const params = useAppParams();

  const go = (path: string) => {
    router.push({
      pathname: path as never,
      params: sharedParams(params),
    });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.canvas }}
      contentContainerStyle={{ paddingBottom: 96 }}
    >
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          backgroundColor: colors.canvas,
        }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: layout.page,
            alignSelf: "center",
            paddingHorizontal: 20,
            paddingTop: 18,
            gap: space.lg,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="WattSteer — back to the landing page"
              onPress={() => router.push("/")}
              style={(state) => {
                const { focused = false } = state as { focused?: boolean };
                return {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  borderRadius: radius.md,
                  padding: 4,
                  ...focusRing(focused, colors.focus),
                  ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                };
              }}
            >
              <WattSteerMark size={22} tint={colors.accent} />
              <Text style={{ fontSize: 15, fontWeight: "700", color: colors.ink }}>
                WattSteer
              </Text>
            </Pressable>
            <View
              style={{
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: colors.border,
                paddingHorizontal: 10,
                paddingVertical: 4,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.inkFaint }}>
                PROTOTYPE · FIXTURE DATA
              </Text>
            </View>
          </View>

          <ScrollView
            horizontal={true}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ flexDirection: "row", gap: 8, paddingBottom: 14 }}
          >
            {SCREENS.map((screen) => (
              <Pill
                key={screen.key}
                accessibilityRole="tab"
                label={screen.label}
                tone="secondary"
                active={
                  screen.path === "/app"
                    ? pathname === "/app" || pathname === "/app/"
                    : pathname.startsWith(screen.path)
                }
                onPress={() => go(screen.path)}
              />
            ))}
          </ScrollView>
        </View>
      </View>

      {showSelection ? <SelectionBar /> : null}

      <View
        style={{
          width: "100%",
          maxWidth: layout.page,
          alignSelf: "center",
          paddingHorizontal: 20,
          paddingTop: space.xl,
          gap: space.xl,
        }}
      >
        {children}
      </View>
    </ScrollView>
  );
}

/** Subsystem, technology and run — the selection every screen reads. */
export function SelectionBar() {
  const colors = usePalette();
  const params = useAppParams();
  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.canvasTint,
      }}
    >
      <ScrollView
        horizontal={true}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xl,
          paddingHorizontal: 20,
          paddingVertical: 12,
        }}
      >
        <Group label="Subsystem">
          {SUBSYSTEMS.map((s) => (
            <MiniPill
              key={s.code}
              label={s.short}
              active={params.subsystem === s.code}
              onPress={() => params.setParams({ subsystem: s.code as SubsystemCode })}
            />
          ))}
        </Group>
        <Group label="Technology">
          {(["WIND", "SOLAR"] as Technology[]).map((tech) => (
            <MiniPill
              key={tech}
              label={tech === "WIND" ? "Wind" : "Solar"}
              active={params.technology === tech}
              onPress={() => params.setParams({ technology: tech })}
            />
          ))}
        </Group>
        <Group label="D−1 run">
          {RUN_LABELS.map((run) => (
            <MiniPill
              key={run}
              label={run}
              active={params.run === run}
              onPress={() => params.setParams({ run: run as RunLabel })}
            />
          ))}
        </Group>
        <View>
          <Text style={{ fontSize: 10, color: colors.inkFaint, marginBottom: 4 }}>
            Target day
          </Text>
          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.ink }}>
            {params.date}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const colors = usePalette();
  return (
    <View>
      <Text style={{ fontSize: 10, color: colors.inkFaint, marginBottom: 4 }}>
        {label}
      </Text>
      <View style={{ flexDirection: "row", gap: 6 }}>{children}</View>
    </View>
  );
}

export function MiniPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const colors = usePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      aria-checked={active}
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={(state) => {
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: active
            ? colors.accentSoft
            : hovered
              ? colors.surfaceSunken
              : "transparent",
          paddingHorizontal: 12,
          paddingVertical: 5,
          ...focusRing(focused, colors.focus, 1),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        };
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: active ? "700" : "500",
          color: active ? colors.onAccentSoft : colors.inkMuted,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Page title block, used at the top of each screen's content. */
export function ScreenTitle({
  title,
  lede,
  right,
}: {
  title: string;
  lede: string;
  right?: ReactNode;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: space.lg,
      }}
    >
      <View style={{ gap: 6, flexGrow: 1, flexBasis: 320 }}>
        <Text
          style={{
            fontSize: 28,
            lineHeight: 34,
            fontWeight: "600",
            letterSpacing: -0.5,
            color: colors.ink,
          }}
        >
          {title}
        </Text>
        <Text style={{ fontSize: 14, lineHeight: 22, color: colors.inkMuted }}>
          {lede}
        </Text>
      </View>
      {right}
    </View>
  );
}
