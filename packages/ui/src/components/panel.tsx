import type { ReactNode } from "react";
import { Text, View, type ViewProps } from "react-native";
import { usePalette } from "../hooks/use-palette";
import { radius } from "../tokens";
import { IconCircle } from "./pill";

/** Rounded-3xl card with hairline border — every dashboard block. */
export function Panel({ children, style, ...rest }: { children: ReactNode } & ViewProps) {
  const colors = usePalette();
  return (
    <View
      {...rest}
      style={[
        {
          borderRadius: radius.xl,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          padding: 20,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * The reference's panel header: outlined icon circle + muted title over a
 * semibold subtitle, with an optional right-side control cluster.
 */
export function PanelHeader({
  icon,
  title,
  subtitle,
  right,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  right?: ReactNode;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <IconCircle>{icon}</IconCircle>
        <View>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
            {title}
          </Text>
          <Text style={{ fontSize: 16, fontWeight: "600", color: colors.ink }}>
            {subtitle}
          </Text>
        </View>
      </View>
      {right}
    </View>
  );
}
