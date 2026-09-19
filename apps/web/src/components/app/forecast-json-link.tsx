import { usePalette } from "@wattsteer/ui";
import { Link } from "expo-router";
import { Platform } from "react-native";
import { useCopy } from "@/i18n";
import { apiUrl } from "@/lib/api-url";
import { API_URL } from "@/lib/config";

/**
 * The API response behind the forecast on screen, one click away.
 *
 * A specialist review (Relatório de Conformidade, AC-09) asked for the full
 * JSON to be reachable from the prototype. The gateway is public and read-only,
 * so the honest version of "the full JSON" is the very request this screen's
 * forecast came from — same subsystem, same day, same gate — rather than a copy
 * of it that could drift from what was drawn.
 */
export function ForecastJsonLink({
  subsystem,
  targetDate,
  gateProfile,
}: {
  subsystem: string;
  targetDate: string;
  gateProfile: string;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const url = apiUrl(API_URL, "/v1/forecast/day-ahead");
  url.searchParams.set("subsystem", subsystem);
  url.searchParams.set("target_date", targetDate);
  url.searchParams.set("gate_profile", gateProfile);
  return (
    <Link
      href={url.toString() as never}
      target="_blank"
      testID="forecast-json-link"
      style={{
        fontSize: 11,
        color: colors.inkMuted,
        textDecorationLine: "underline",
        ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
      }}
    >
      {copy.app.explain.jsonLink}
    </Link>
  );
}
