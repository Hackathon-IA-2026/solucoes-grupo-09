/**
 * A thumbnail of the country with one subsystem lit, for the summary rail.
 *
 * **Why a picture beside a name that is already there.** The rail's four rows
 * and the map beside them are the same four regions, and matching a row to a
 * shape currently costs the reader a translation: `SE/CO` is a code, the map
 * writes it over a polygon, and nothing in the row says which polygon. The
 * thumbnail closes that without a hover, a tooltip or a second interaction —
 * which matters most for the reader who is *not* going to touch anything,
 * because this screen is read far more often than it is driven.
 *
 * **It is the same geometry as the map, not a redrawing of it.**
 * `SUBSYSTEM_PATH_D` and `BRAZIL_VIEWBOX` are the flat map's own, so a shape
 * here cannot drift from the shape a reader just looked at. That is the whole
 * reason this is thirty lines rather than a second set of paths: two maps of
 * one country that disagree is the defect `region-map.tsx` was written to end.
 *
 * **Decoration, deliberately.** It carries no figure and no risk colour — the
 * row beside it says the magnitude, the class and the interval, and a fifth
 * channel repeating one of them would be a fifth thing to keep in step. So it
 * is `aria-hidden`: a screen reader is told the region's name by the row, and
 * an outline adds nothing it can say.
 */

import { usePalette } from "@wattsteer/ui";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { SubsystemCode } from "@/lib/fixtures";
import { BRAZIL_VIEWBOX, SUBSYSTEM_PATH_D } from "@/lib/geo/brazil-geometry";

export function MiniMap({
  subsystem,
  selected,
  size = 46,
}: {
  subsystem: SubsystemCode;
  /** The selected row's thumbnail keeps the accent the rest of its row wears. */
  selected: boolean;
  size?: number;
}) {
  const colors = usePalette();
  const lit = selected ? colors.accent : colors.inkMuted;
  return (
    <View
      aria-hidden={true}
      style={{
        width: size,
        height: size * (BRAZIL_VIEWBOX.height / BRAZIL_VIEWBOX.width),
        // Never give width back: `flexShrink` defaults to 0 here (ADR-0001) and
        // a thumbnail that shrank would be four different sizes down the rail.
        flexShrink: 0,
      }}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${BRAZIL_VIEWBOX.width} ${BRAZIL_VIEWBOX.height}`}
      >
        {/*
          The other three first, so the lit one is never drawn under a
          neighbour. They are one flat tone rather than four: this is a
          locator, and a thumbnail that shaded every region would be a second
          choropleth competing with the real one.
        */}
        {(Object.keys(SUBSYSTEM_PATH_D) as SubsystemCode[])
          .filter((code) => code !== subsystem)
          .map((code) => (
            <Path key={code} d={SUBSYSTEM_PATH_D[code]} fill={colors.surfaceSunken} />
          ))}
        <Path d={SUBSYSTEM_PATH_D[subsystem]} fill={lit} />
      </Svg>
    </View>
  );
}
