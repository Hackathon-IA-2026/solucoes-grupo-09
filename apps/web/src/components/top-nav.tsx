import {
  BellIcon,
  ChevronDownIcon,
  focusRing,
  IconCircleButton,
  LayoutDashboardIcon,
  Pill,
  SearchIcon,
  usePalette,
  WattSteerMark,
} from "@wattsteer/ui";
import { Image } from "expo-image";
import { useState } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";

const TABS = [
  { label: "Overview", icon: true },
  { label: "Insights", dropdown: true },
  { label: "Analytics", badge: 7 },
  { label: "Audiences" },
  { label: "Reports" },
] as const;

// Stable array instance for FlatList `data` (a fresh spread each render would
// redraw every row).
const TAB_DATA = [...TABS];

/**
 * Reference `TopNav`: grape logo tile, scrollable tab pills (lime active,
 * icon/badge/chevron variants), and the search / bell / avatar cluster.
 *
 * NOT RENDERED right now — it's awesome, so it stays for when the dashboard
 * grows real sections (swap `TopNav` back to this in dashboard.tsx).
 */
export function TopNavFull() {
  const colors = usePalette();
  const [active, setActive] = useState<string>("Overview");

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      {/* logo tile */}
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 16,
          borderCurve: "continuous",
          backgroundColor: colors.violet,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <WattSteerMark size={24} tint={colors.violet} />
      </View>

      {/* tab pills */}
      <FlatList
        horizontal={true}
        data={TAB_DATA}
        keyExtractor={(tab) => tab.label}
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        renderItem={({ item: tab }) => {
          const isActive = active === tab.label;
          const fg = isActive ? colors.onAccent : colors.inkMuted;
          return (
            <Pill
              accessibilityRole="tab"
              label={tab.label}
              active={isActive}
              onPress={() => setActive(tab.label)}
              icon={
                "icon" in tab && tab.icon ? (
                  <LayoutDashboardIcon size={16} color={fg} />
                ) : undefined
              }
              trailing={
                "badge" in tab && tab.badge ? (
                  <View
                    style={{
                      minWidth: 20,
                      height: 20,
                      borderRadius: 10,
                      paddingHorizontal: 4,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: isActive
                        ? "rgba(30, 43, 16, 0.15)"
                        : colors.accent,
                    }}
                  >
                    <Text
                      style={{ fontSize: 12, fontWeight: "700", color: colors.onAccent }}
                    >
                      {tab.badge}
                    </Text>
                  </View>
                ) : "dropdown" in tab && tab.dropdown ? (
                  <View style={{ opacity: 0.7 }}>
                    <ChevronDownIcon size={14} color={fg} />
                  </View>
                ) : undefined
              }
            />
          );
        }}
      />

      {/* right cluster */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <IconCircleButton label="Search" onPress={() => {}}>
          <SearchIcon size={18} color={colors.inkMuted} />
        </IconCircleButton>
        <IconCircleButton label="Notifications" onPress={() => {}}>
          <View>
            <BellIcon size={18} color={colors.inkMuted} />
            <View
              style={[
                styles.bellDot,
                { backgroundColor: colors.accent, borderColor: colors.surface },
              ]}
            />
          </View>
        </IconCircleButton>
        {/* avatar with grape ring */}
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            padding: 3,
            borderWidth: 2,
            borderColor: colors.violet,
            backgroundColor: "rgba(141, 93, 246, 0.2)",
          }}
        >
          <View
            style={{
              flex: 1,
              borderRadius: 17,
              backgroundColor: colors.violet,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "700", color: "#FFFFFF" }}>NV</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bellDot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
  },
});

/**
 * Current dashboard header: just the logo, centered — tapping it
 * returns to the home/hero screen.
 */
export function TopNav({ onHome }: { onHome: () => void }) {
  const colors = usePalette();
  return (
    <View style={{ alignItems: "center" }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="WattSteer — back to home"
        testID="nav-home"
        onPress={onHome}
        style={(state) => {
          const { pressed } = state;
          const { hovered = false, focused = false } = state as {
            hovered?: boolean;
            focused?: boolean;
          };
          return {
            padding: 8,
            borderRadius: 12,
            transform: [{ scale: pressed ? 0.94 : hovered ? 1.06 : 1 }],
            ...focusRing(focused, colors.focus),
            ...(Platform.OS === "web"
              ? ({
                  cursor: "pointer",
                  transitionProperty: "transform",
                  transitionDuration: "150ms",
                } as object)
              : null),
          };
        }}
      >
        <Image
          source={require("../../assets/images/logo.png")}
          style={{ width: 40, height: 44 }}
          contentFit="contain"
          transition={150}
        />
      </Pressable>
    </View>
  );
}
