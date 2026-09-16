/**
 * One scene, drawn.
 *
 * Every case here wraps a component the product already has. That is the whole
 * economy of this feature: a briefing is the screens' own panels, sequenced, so
 * a reader who watches one and then opens the screen is looking at the same
 * drawing rather than at a presentation *about* the screen.
 *
 * Scenes not yet built render nothing rather than a placeholder. A placeholder
 * in a briefing is a panel that says "coming soon" to an operator mid-answer;
 * `compose.ts` decides what a briefing contains, so the honest way to withhold
 * a scene is to stop composing it, and the honest thing to do with one that
 * slipped through is to let the sequence move on.
 */

import { space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import type { MapPaint } from "@/components/charts/subsystem-map";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { useCopy } from "@/i18n";
import { subsystemMeta } from "@/lib/fixtures";
import type { Scene } from "@/lib/voice/briefing/types";

export interface SceneProps {
  readonly scene: Scene;
  /**
   * What the map should paint, when the sequence reaches a map scene.
   *
   * Passed in rather than read here: the rows belong to the screen underneath,
   * and a briefing that fetched its own copy could disagree with the screen a
   * reader dismisses back onto.
   */
  readonly paint: MapPaint | null;
}

/** The opening card: what this briefing is about, before it starts moving. */
function TitleScene({ scene }: { scene: Extract<Scene, { type: "title" }> }) {
  const colors = usePalette();
  const copy = useCopy();
  const meta = scene.subsystem === null ? null : subsystemMeta(scene.subsystem);
  return (
    <View style={{ gap: space.sm, alignItems: "center" }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: colors.inkMuted }}>
        {copy.briefing.scenes.title}
      </Text>
      <Text
        accessibilityRole="header"
        style={{
          fontSize: 34,
          lineHeight: 40,
          fontWeight: "600",
          letterSpacing: -0.8,
          textAlign: "center",
          color: colors.ink,
        }}
      >
        {meta?.onsDisplayName ?? copy.briefing.label}
      </Text>
    </View>
  );
}

/** The map, pointed at one region. */
function MapFocusScene({
  scene,
  paint,
}: {
  scene: Extract<Scene, { type: "map_focus" }>;
  paint: MapPaint | null;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const meta = subsystemMeta(scene.subsystem);
  return (
    <View style={{ gap: space.md, alignItems: "center" }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: colors.inkMuted }}>
        {copy.briefing.scenes.mapFocus}
      </Text>
      {paint === null ? (
        // No rows to paint. The region still gets named, because "where" is the
        // one thing this scene is for and the name answers it without a map.
        <Text style={{ fontSize: 28, fontWeight: "600", color: colors.ink }}>
          {meta.onsDisplayName}
        </Text>
      ) : (
        <SubsystemMap
          paint={paint}
          selected={scene.subsystem}
          hovered={scene.subsystem}
          onSelect={() => {}}
        />
      )}
    </View>
  );
}

export function SceneRenderer({ scene, paint }: SceneProps) {
  switch (scene.type) {
    case "title":
      return <TitleScene scene={scene} />;
    case "map_focus":
      return <MapFocusScene scene={scene} paint={paint} />;
    default:
      return null;
  }
}
