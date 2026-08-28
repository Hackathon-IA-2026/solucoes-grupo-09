import { usePalette } from "@negotiatio/ui";
import { Image } from "expo-image";
import { useState } from "react";
import { Text, View } from "react-native";

/** Two-letter initials from an issuer name, for the logo fallback. */
function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\s]/gu, "")
    .trim()
    .split(/\s+/);
  const first = words[0]?.[0] ?? "";
  const second = words[1]?.[0] ?? "";
  return (first + second).toUpperCase() || "•";
}

/**
 * Rounded issuer logo with a graceful initials fallback (many thumbnails 404
 * or are missing). Uses expo-image for caching + fast decode.
 */
export function IssuerLogo({
  uri,
  name,
  size = 40,
}: {
  uri: string | null;
  name: string;
  size?: number;
}) {
  const colors = usePalette();
  const [failed, setFailed] = useState(false);

  if (!uri || failed) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 10,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surfaceSunken,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Text
          style={{
            fontSize: size * 0.34,
            fontWeight: "700",
            color: colors.inkMuted,
          }}
        >
          {initials(name)}
        </Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      onError={() => setFailed(true)}
      contentFit="contain"
      transition={200}
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        backgroundColor: "#FFFFFF",
        borderWidth: 1,
        borderColor: colors.border,
      }}
    />
  );
}
