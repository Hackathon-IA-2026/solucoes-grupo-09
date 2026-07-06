import {
  BellIcon,
  ChevronDownIcon,
  IconCircleButton,
  LayoutDashboardIcon,
  NoviqMark,
  Pill,
  SearchIcon,
  usePalette,
} from "@noviq/ui";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";

const TABS = [
  { label: "Overview", icon: true },
  { label: "Insights", dropdown: true },
  { label: "Analytics", badge: 7 },
  { label: "Audiences" },
  { label: "Reports" },
] as const;

/**
 * Reference `TopNav`: grape logo tile, scrollable tab pills (lime active,
 * icon/badge/chevron variants), and the search / bell / avatar cluster.
 */
export function TopNav() {
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
        <NoviqMark size={24} tint={colors.violet} />
      </View>

      {/* tab pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        {TABS.map((tab) => {
          const isActive = active === tab.label;
          const fg = isActive ? colors.onAccent : colors.inkMuted;
          return (
            <Pill
              key={tab.label}
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
                      style={{ fontSize: 11, fontWeight: "700", color: colors.onAccent }}
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
        })}
      </ScrollView>

      {/* right cluster */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <IconCircleButton label="Search" onPress={() => {}}>
          <SearchIcon size={18} color={colors.inkMuted} />
        </IconCircleButton>
        <IconCircleButton label="Notifications" onPress={() => {}}>
          <View>
            <BellIcon size={18} color={colors.inkMuted} />
            <View
              style={{
                position: "absolute",
                top: -2,
                right: -2,
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: colors.accent,
                borderWidth: 2,
                borderColor: colors.surface,
              }}
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
