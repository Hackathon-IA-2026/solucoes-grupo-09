import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { usePalette } from "../hooks/use-palette";
import { radius } from "../tokens";

type Tone = "accent" | "violet" | "info" | "warning" | "danger" | "neutral";

/**
 * Small solid rounded label — a subsystem tag ("NE", "SE/CO"), a restriction
 * reason ("ENE", "CNF"), a data-vintage marker. Distinct from `Pill`, which is
 * an interactive control; a `Badge` is purely descriptive.
 */
export function Badge({
  label,
  tone = "accent",
  icon,
}: {
  label: string;
  tone?: Tone;
  icon?: ReactNode;
}) {
  const colors = usePalette();
  const map: Record<Tone, { bg: string; fg: string }> = {
    accent: { bg: colors.accentSoft, fg: colors.onAccentSoft },
    violet: { bg: colors.violetSoft, fg: colors.onVioletSoft },
    info: { bg: colors.infoSoft, fg: colors.onInfoSoft },
    warning: { bg: colors.warningSoft, fg: colors.onWarningSoft },
    danger: { bg: colors.dangerSoft, fg: colors.onDangerSoft },
    neutral: { bg: colors.surfaceSunken, fg: colors.inkMuted },
  };
  const { bg, fg } = map[tone];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        // `center` (not flex-start): in a row it keeps every badge vertically
        // centered on one line — a badge with an icon no longer sits higher
        // than a plain one — and it still hugs its content in a column.
        alignSelf: "center",
        backgroundColor: bg,
        borderRadius: radius.sm,
        borderCurve: "continuous",
        paddingHorizontal: 8,
        paddingVertical: 4,
      }}
    >
      {icon}
      <Text style={{ fontSize: 12, fontWeight: "700", color: fg, letterSpacing: 0.2 }}>
        {label}
      </Text>
    </View>
  );
}
