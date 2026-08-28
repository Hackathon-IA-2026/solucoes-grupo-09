import {
  BuildingIcon,
  CheckIcon,
  ClockIcon,
  CoinsIcon,
  DropletIcon,
  LayersIcon,
  PercentIcon,
  radius,
  Toggle,
  usePalette,
  XIcon,
} from "@negotiatio/ui";
import { type ReactNode, useEffect } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  SlideInRight,
  SlideOutRight,
} from "react-native-reanimated";
import { useI18n } from "@/i18n";
import type { FacetOption, Facets, FilterField, FilterState } from "@/lib/offers";
import { SORT_OPTIONS, type SortKey } from "@/lib/offers";

/** Display name per category key (stable across locales). */
const CATEGORY_LABEL: Record<string, string> = {
  cdb: "CDB",
  lci: "LCI",
  lca: "LCA",
  debenture: "Debênture",
  cri: "CRI",
  cra: "CRA",
};

/** One selectable chip — lime when active, with the option count. */
function Chip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count?: number;
  active: boolean;
  onPress: () => void;
}) {
  const colors = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      aria-checked={active}
      style={(state) => {
        const { hovered = false, pressed = false } = state as {
          hovered?: boolean;
          pressed?: boolean;
        };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: active ? colors.accent : colors.borderStrong,
          backgroundColor: active
            ? colors.accent
            : hovered
              ? colors.surfaceSunken
              : colors.surface,
          paddingHorizontal: 13,
          paddingVertical: 8,
          transform: [{ scale: pressed ? 0.95 : 1 }],
          ...(Platform.OS === "web"
            ? ({
                cursor: "pointer",
                transitionProperty: "background-color, border-color, transform",
                transitionDuration: "150ms",
              } as object)
            : null),
        };
      }}
    >
      {active ? <CheckIcon size={13} color={colors.onAccent} strokeWidth={3} /> : null}
      <Text
        style={{
          fontSize: 13,
          fontWeight: active ? "700" : "500",
          color: active ? colors.onAccent : colors.inkMuted,
        }}
      >
        {label}
      </Text>
      {count != null && !active ? (
        <Text style={{ fontSize: 12, color: colors.inkFaint }}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

/** A titled chip group inside the drawer. */
function Section({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  const colors = usePalette();
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {icon}
        <Text style={{ fontSize: 14, fontWeight: "700", color: colors.ink }}>
          {title}
        </Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{children}</View>
    </View>
  );
}

export interface FilterDrawerProps {
  open: boolean;
  onClose: () => void;
  filters: FilterState;
  facets: Facets;
  termOptions: FacetOption[];
  resultCount: number;
  onToggleArray: (field: FilterField, value: string) => void;
  onFgc: (value: boolean) => void;
  onSort: (value: SortKey) => void;
  onReset: () => void;
}

/**
 * Lateral filter drawer — the mobile/tablet home of every filter. Slides in
 * from the right (reanimated) over a fading backdrop, lists each filter as a
 * chip group with live counts, and closes through a sticky "show N offers"
 * call-to-action so the result count is always one glance away.
 */
export function FilterDrawer(props: FilterDrawerProps) {
  const { open, onClose } = props;

  // Lock the page behind the drawer while it's open (web only — native Modal
  // already captures the viewport). Restores the previous overflow on close.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || !open) {
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Native: a real Modal (own window, hardware back handled). Web: a fixed
  // overlay — Modal on RN Web traps scroll awkwardly and breaks position:fixed.
  if (Platform.OS !== "web") {
    return (
      <Modal
        visible={open}
        transparent={true}
        animationType="none"
        onRequestClose={onClose}
      >
        <DrawerBody {...props} />
      </Modal>
    );
  }
  if (!open) {
    return null;
  }
  return (
    <View
      style={
        {
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 100,
        } as object
      }
    >
      <DrawerBody {...props} />
    </View>
  );
}

function DrawerBody({
  onClose,
  filters,
  facets,
  termOptions,
  resultCount,
  onToggleArray,
  onFgc,
  onSort,
  onReset,
}: FilterDrawerProps) {
  const colors = usePalette();
  const { t, tEnum } = useI18n();
  const iconColor = colors.inkMuted;

  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      {/* backdrop */}
      <Animated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(150)}
        style={{ ...StyleSheetAbsoluteFill, backgroundColor: "rgba(0, 0, 0, 0.55)" }}
      >
        <Pressable
          accessibilityLabel={t("filter.close")}
          onPress={onClose}
          style={{ flex: 1 }}
        />
      </Animated.View>

      {/* panel */}
      <Animated.View
        entering={SlideInRight.springify().damping(22).stiffness(220)}
        exiting={SlideOutRight.duration(200)}
        style={{
          marginLeft: "auto",
          width: "100%",
          maxWidth: 420,
          height: "100%",
          backgroundColor: colors.canvasTint,
          borderLeftWidth: 1,
          borderLeftColor: colors.borderStrong,
          ...(Platform.OS === "web"
            ? ({ boxShadow: colors.shadowFloat } as object)
            : null),
        }}
      >
        {/* header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 20,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: "700", color: colors.ink }}>
            {t("filter.title")}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("filter.close")}
            hitSlop={8}
            style={(state) => {
              const { hovered = false } = state as { hovered?: boolean };
              return {
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: hovered ? colors.surfaceSunken : colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
                ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
              };
            }}
          >
            <XIcon size={16} color={colors.inkMuted} />
          </Pressable>
        </View>

        {/* sections */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, gap: 24 }}
          showsVerticalScrollIndicator={false}
        >
          {/* FGC */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: colors.border,
              paddingHorizontal: 16,
              paddingVertical: 14,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
              {t("filter.fgc")}
            </Text>
            <Toggle
              value={filters.fgcOnly}
              onValueChange={onFgc}
              label={t("filter.fgc")}
            />
          </View>

          <Section
            icon={<LayersIcon size={16} color={iconColor} />}
            title={t("filter.type")}
          >
            {facets.type.map((opt) => (
              <Chip
                key={opt.value}
                label={CATEGORY_LABEL[opt.value] ?? opt.value.toUpperCase()}
                count={opt.count}
                active={filters.type.includes(opt.value)}
                onPress={() => onToggleArray("type", opt.value)}
              />
            ))}
          </Section>

          <Section
            icon={<ClockIcon size={16} color={iconColor} />}
            title={t("filter.term")}
          >
            {termOptions.map((opt) => (
              <Chip
                key={opt.value}
                label={t(`term.${opt.value}` as "term.upTo1")}
                count={opt.count}
                active={filters.term.includes(opt.value as never)}
                onPress={() => onToggleArray("term", opt.value)}
              />
            ))}
          </Section>

          <Section
            icon={<BuildingIcon size={16} color={iconColor} />}
            title={t("filter.distributor")}
          >
            {facets.distributor.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.value}
                count={opt.count}
                active={filters.distributor.includes(opt.value)}
                onPress={() => onToggleArray("distributor", opt.value)}
              />
            ))}
          </Section>

          <Section
            icon={<DropletIcon size={16} color={iconColor} />}
            title={t("filter.liquidity")}
          >
            {facets.liquidity.map((opt) => (
              <Chip
                key={opt.value}
                label={tEnum("liquidity", opt.value)}
                count={opt.count}
                active={filters.liquidity.includes(opt.value)}
                onPress={() => onToggleArray("liquidity", opt.value)}
              />
            ))}
          </Section>

          <Section
            icon={<CoinsIcon size={16} color={iconColor} />}
            title={t("filter.taxation")}
          >
            {facets.taxation.map((opt) => (
              <Chip
                key={opt.value}
                label={tEnum("taxation", opt.value)}
                count={opt.count}
                active={filters.taxation.includes(opt.value)}
                onPress={() => onToggleArray("taxation", opt.value)}
              />
            ))}
          </Section>

          <Section
            icon={<PercentIcon size={16} color={iconColor} />}
            title={t("filter.indexer")}
          >
            {facets.indexer.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.value}
                count={opt.count}
                active={filters.indexer.includes(opt.value)}
                onPress={() => onToggleArray("indexer", opt.value)}
              />
            ))}
          </Section>

          <Section
            icon={<ClockIcon size={16} color={iconColor} />}
            title={t("filter.sort")}
          >
            {SORT_OPTIONS.map((key) => (
              <Chip
                key={key}
                label={t(`sort.${key}` as "sort.netDesc")}
                active={filters.sort === key}
                onPress={() => onSort(key)}
              />
            ))}
          </Section>
        </ScrollView>

        {/* sticky footer */}
        <View
          style={{
            flexDirection: "row",
            gap: 10,
            padding: 16,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.canvasTint,
          }}
        >
          <Pressable
            onPress={onReset}
            accessibilityRole="button"
            style={(state) => {
              const { hovered = false } = state as { hovered?: boolean };
              return {
                paddingHorizontal: 18,
                paddingVertical: 13,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: colors.borderStrong,
                backgroundColor: hovered ? colors.surfaceSunken : "transparent",
                ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
              };
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.inkMuted }}>
              {t("filter.clear")}
            </Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={(state) => {
              const { hovered = false, pressed = false } = state as {
                hovered?: boolean;
                pressed?: boolean;
              };
              return {
                flex: 1,
                alignItems: "center",
                paddingVertical: 13,
                borderRadius: radius.pill,
                backgroundColor: hovered ? colors.accentStrong : colors.accent,
                transform: [{ scale: pressed ? 0.98 : 1 }],
                ...(Platform.OS === "web"
                  ? ({
                      cursor: "pointer",
                      transitionProperty: "background-color, transform",
                      transitionDuration: "150ms",
                    } as object)
                  : null),
              };
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.onAccent }}>
              {t("filter.showResults", { n: resultCount })}
            </Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

/** RN's StyleSheet.absoluteFill as a plain object (spreadable on web). */
const StyleSheetAbsoluteFill = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};
