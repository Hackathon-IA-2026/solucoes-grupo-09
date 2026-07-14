import type { ReactNode } from "react";
import { type LayoutChangeEvent, Platform, Pressable, Text, View } from "react-native";
import { usePalette } from "../hooks/use-palette";
import { focusRing } from "../lib/focus-ring";
import { radius, space } from "../tokens";

/**
 * Legal-page primitives (terms / privacy), styled with the Zalytix design
 * system: dark charcoal surfaces, lime accents, grape for emphasis, hairline
 * borders and pill controls. Pure View+Text presentation — no data logic.
 */

export interface LegalTocSection {
  id: string;
  title: string;
}

type Tone = "default" | "accent" | "warning" | "danger";

/** Hero card at the top of a legal page: badge, updated date, h1, intro. */
export function LegalHero({
  badge,
  updated,
  title,
  intro,
}: {
  badge: string;
  updated: string;
  title: string;
  intro: string;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: space.xl,
        marginBottom: space.xxl,
      }}
    >
      <View
        style={{
          alignSelf: "flex-start",
          borderRadius: radius.pill,
          backgroundColor: colors.accent,
          paddingHorizontal: 12,
          paddingVertical: 5,
          marginBottom: space.md,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "700", color: colors.onAccent }}>
          {badge}
        </Text>
      </View>
      <Text style={{ fontSize: 13, color: colors.inkMuted, marginBottom: space.sm }}>
        {updated}
      </Text>
      <Text
        accessibilityRole="header"
        aria-level={1}
        selectable={true}
        style={{
          fontSize: 34,
          lineHeight: 40,
          fontWeight: "600",
          letterSpacing: -1,
          color: colors.ink,
          marginBottom: space.md,
        }}
      >
        {title}
      </Text>
      <Text style={{ fontSize: 17, lineHeight: 27, color: colors.inkMuted }}>
        {intro}
      </Text>
    </View>
  );
}

/** Table-of-contents sidebar with active-section highlight (lime). */
export function LegalSidebar({
  title,
  sections,
  activeSection,
  onSectionPress,
}: {
  title: string;
  sections: ReadonlyArray<LegalTocSection>;
  activeSection: string;
  onSectionPress: (id: string) => void;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: space.md,
      }}
    >
      <Text
        style={{
          fontSize: 12,
          fontWeight: "700",
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: colors.inkFaint,
          marginBottom: space.sm,
          paddingHorizontal: space.sm,
        }}
      >
        {title}
      </Text>
      <View testID="legal.sidebar.navigation" style={{ gap: 2 }}>
        {sections.map((section) => {
          const active = section.id === activeSection;
          return (
            <Pressable
              key={section.id}
              testID={`legal.sidebar.item.${section.id}`}
              accessibilityRole="link"
              accessibilityState={{ selected: active }}
              onPress={() => onSectionPress(section.id)}
              hitSlop={4}
              style={(state) => {
                const { hovered = false, focused = false } = state as {
                  hovered?: boolean;
                  focused?: boolean;
                };
                return {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  borderRadius: radius.sm,
                  paddingHorizontal: space.sm,
                  paddingVertical: 7,
                  backgroundColor: active
                    ? colors.accentSoft
                    : hovered
                      ? colors.surfaceSunken
                      : "transparent",
                  ...focusRing(focused, colors.focus, 1),
                  ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                };
              }}
            >
              <View
                style={{
                  width: 3,
                  alignSelf: "stretch",
                  borderRadius: 2,
                  backgroundColor: active ? colors.accent : "transparent",
                }}
              />
              <Text
                style={{
                  flex: 1,
                  fontSize: 13,
                  fontWeight: active ? "600" : "500",
                  color: active ? colors.accent : colors.inkMuted,
                }}
              >
                {section.title}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A titled content section, measured via onLayout for scroll tracking. */
export function LegalSection({
  id,
  title,
  onLayout,
  children,
}: {
  id: string;
  title: string;
  onLayout?: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const colors = usePalette();
  return (
    <View
      testID={`legal.content.section.${id}`}
      onLayout={onLayout}
      style={{ marginBottom: space.xxl }}
    >
      <Text
        accessibilityRole="header"
        aria-level={2}
        style={{
          fontSize: 22,
          lineHeight: 28,
          fontWeight: "600",
          letterSpacing: -0.4,
          color: colors.ink,
          marginBottom: space.lg,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Sub-heading + optional subtitle inside a section. */
export function SectionHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  const colors = usePalette();
  return (
    <View style={{ marginBottom: space.md }}>
      <Text
        style={{
          fontSize: 16,
          fontWeight: "600",
          color: colors.ink,
          marginBottom: subtitle ? 6 : 0,
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text style={{ fontSize: 15, lineHeight: 24, color: colors.inkMuted }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

/** Plain body paragraph. */
export function LegalText({ children }: { children: ReactNode }) {
  const colors = usePalette();
  return (
    <Text
      selectable={true}
      style={{
        fontSize: 15,
        lineHeight: 24,
        color: colors.inkMuted,
        marginBottom: space.md,
      }}
    >
      {children}
    </Text>
  );
}

/** Lime-dot bullet list. `onDark` uses light bullets/text for tinted cards. */
export function BulletList({
  items,
  onDark = false,
}: {
  items: ReadonlyArray<string>;
  onDark?: boolean;
}) {
  const colors = usePalette();
  const dot = onDark ? colors.onAccent : colors.accent;
  const text = onDark ? colors.onAccent : colors.inkMuted;
  return (
    <View style={{ gap: space.sm }}>
      {items.map((item) => (
        <View key={item} style={{ flexDirection: "row", gap: space.md }}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              marginTop: 8,
              backgroundColor: dot,
            }}
          />
          <Text
            selectable={true}
            style={{ flex: 1, fontSize: 15, lineHeight: 24, color: text }}
          >
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

function toneColors(tone: Tone, colors: ReturnType<typeof usePalette>) {
  switch (tone) {
    case "accent":
      return { bg: colors.accent, border: colors.accent, title: colors.onAccent };
    case "warning":
      return {
        bg: colors.warningSoft,
        border: "rgba(237, 162, 63, 0.3)",
        title: colors.ink,
      };
    case "danger":
      return {
        bg: colors.dangerSoft,
        border: "rgba(234, 74, 61, 0.3)",
        title: colors.ink,
      };
    default:
      return { bg: colors.surfaceSunken, border: colors.border, title: colors.ink };
  }
}

/** Callout card. `accent` fills lime (use onDark bullets/text inside). */
export function LegalCard({
  tone = "default",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const colors = usePalette();
  const c = toneColors(tone, colors);
  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.bg,
        padding: space.lg,
        marginBottom: space.md,
      }}
    >
      {title ? (
        <Text
          style={{
            fontSize: 15,
            fontWeight: "700",
            color: c.title,
            marginBottom: space.sm,
          }}
        >
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/** Responsive wrapping grid for Data/Icon/Right cards. */
export function CardGrid({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: space.md,
        marginBottom: space.md,
      }}
    >
      {children}
    </View>
  );
}

/** Sunken card: bold title + muted description (data-point tiles). */
export function DataCard({ title, description }: { title: string; description: string }) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 220,
        minWidth: 180,
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surfaceSunken,
        padding: space.lg,
      }}
    >
      <Text
        style={{ fontSize: 15, fontWeight: "600", color: colors.ink, marginBottom: 4 }}
      >
        {title}
      </Text>
      <Text style={{ fontSize: 13, lineHeight: 19, color: colors.inkMuted }}>
        {description}
      </Text>
    </View>
  );
}

/** Data card with a leading emoji glyph. */
export function IconCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 220,
        minWidth: 180,
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surfaceSunken,
        padding: space.lg,
      }}
    >
      <Text style={{ fontSize: 22, marginBottom: space.sm }}>{icon}</Text>
      <Text
        style={{ fontSize: 15, fontWeight: "600", color: colors.ink, marginBottom: 4 }}
      >
        {title}
      </Text>
      <Text style={{ fontSize: 13, lineHeight: 19, color: colors.inkMuted }}>
        {description}
      </Text>
    </View>
  );
}

/** Row card with a lime check — user-rights style. */
export function RightCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surfaceSunken,
        padding: space.lg,
        marginBottom: space.sm,
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "900", color: colors.onAccent }}>✓</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={{ fontSize: 15, fontWeight: "600", color: colors.ink, marginBottom: 2 }}
        >
          {title}
        </Text>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.inkMuted }}>
          {description}
        </Text>
      </View>
    </View>
  );
}

/** Simple bordered table: sunken header row + hairline-separated rows. */
export function LegalTable({
  headers,
  rows,
}: {
  headers: ReadonlyArray<string>;
  rows: ReadonlyArray<ReadonlyArray<string>>;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        overflow: "hidden",
        marginBottom: space.md,
      }}
    >
      <View style={{ flexDirection: "row", backgroundColor: colors.surfaceSunken }}>
        {headers.map((header) => (
          <View key={header} style={{ flex: 1, padding: space.md }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: colors.ink }}>
              {header}
            </Text>
          </View>
        ))}
      </View>
      {rows.map((row, rowIndex) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: static legal table rows are positional
          key={rowIndex}
          style={{
            flexDirection: "row",
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          {row.map((cell, cellIndex) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: static legal table cells are positional
              key={cellIndex}
              style={{ flex: 1, padding: space.md }}
            >
              <Text
                selectable={true}
                style={{ fontSize: 13, lineHeight: 18, color: colors.inkMuted }}
              >
                {cell}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** Hairline section divider. */
export function LegalDivider() {
  const colors = usePalette();
  return (
    <View
      style={{ height: 1, backgroundColor: colors.border, marginVertical: space.xl }}
    />
  );
}
