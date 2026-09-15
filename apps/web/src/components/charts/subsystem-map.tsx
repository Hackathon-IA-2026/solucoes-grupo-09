/**
 * Brazil, drawn as the four ONS subsystems, as a second way into the same
 * selection the rows underneath make.
 *
 * **Why a map at all.** The four rows already carry every number; a map
 * carries none of them. What it carries is *where* — that the NE is a coastal
 * block, that SE/CO is the centre and the south-east together, that N is most
 * of the landmass and a small share of the load. A reader who knows the grid
 * reads the shape faster than four names, and a reader who does not learns
 * which four names they are looking at. It is a navigation aid, not a figure:
 * nothing is encoded here that the rows do not state in words.
 *
 * **It is not a second selection model.** The map takes the same `onSelect`
 * the rows take and the same `selected` code. Clicking a region and clicking a
 * row are the same call. See `app/app/index.tsx`, where one handler is defined
 * once and handed to both.
 *
 * **Colour is `risk-class.tsx`'s, imported not re-derived.** Three bins, no
 * ramp, low in `inkMuted` rather than lime — the reasoning is in that file's
 * header and it applies here unchanged. Colour is never the only encoding: the
 * subsystem's short code is printed on the region and the same three-step
 * glyph the chip uses is drawn under it, so the map still reads with the hues
 * removed.
 *
 * **Geometry** lives in `@/lib/geo/brazil-subsystems` — source, licence,
 * projection and the simplification trade-off are all documented there.
 */

import {
  focusRing,
  motion,
  space,
  useContainerWidth,
  usePalette,
  useReducedMotion,
  webTransition,
} from "@wattsteer/ui";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import Svg, { G, Path, Rect, Text as SvgText } from "react-native-svg";
import { riskColor } from "@/components/charts/risk-class";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  type RiskClass,
  riskClass,
  roundProbability,
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  type SubsystemDayForecast,
  subsystemMeta,
} from "@/lib/fixtures";
import {
  BRAZIL_VIEWBOX,
  STATE_BORDER_D,
  SUBSYSTEM_LABEL_ANCHOR,
  SUBSYSTEM_PATH,
} from "@/lib/geo/brazil-subsystems";

const FONT =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

/**
 * The drawn width, in CSS pixels, on a container wide enough to allow it.
 *
 * Brazil is nearly square (the viewBox is 1000 × 972), so a map that takes the
 * full 1152 px page would be a metre of screen for four words. Capped, and
 * centred in whatever is left. At the 400 px phone width the cap never binds
 * and the map is simply the column width, which is why nothing here can
 * overflow horizontally.
 */
const MAX_WIDTH = 380;

/** The three-step glyph from the risk chip, in SVG. Never colour alone. */
function Steps({
  klass,
  x,
  y,
  color,
  dim,
}: {
  klass: RiskClass;
  x: number;
  y: number;
  color: string;
  dim: string;
}) {
  const level = { low: 1, elevated: 2, high: 3 }[klass];
  const unit = 9;
  return (
    <G>
      {[1, 2, 3].map((step) => (
        <Rect
          key={step}
          x={x - 17 + (step - 1) * 12}
          y={y - unit * step}
          width={7}
          height={unit * step}
          rx={2}
          fill={step <= level ? color : dim}
        />
      ))}
    </G>
  );
}

export function SubsystemMap({
  forecasts,
  selected,
  onSelect,
}: {
  forecasts: SubsystemDayForecast[];
  selected: SubsystemCode;
  /** The overview's own row handler. Not a map-specific one. */
  onSelect: (subsystem: SubsystemCode) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const reduced = useReducedMotion();
  const [containerWidth, onLayout] = useContainerWidth();
  const [active, setActive] = useState<SubsystemCode | null>(null);

  const width = Math.min(containerWidth > 0 ? containerWidth : MAX_WIDTH, MAX_WIDTH);
  const height = (width * BRAZIL_VIEWBOX.height) / BRAZIL_VIEWBOX.width;

  const byCode = new Map(forecasts.map((each) => [each.subsystem, each]));

  return (
    <View onLayout={onLayout} style={{ alignItems: "center" }}>
      <Svg
        viewBox={`0 0 ${BRAZIL_VIEWBOX.width} ${BRAZIL_VIEWBOX.height}`}
        width={width}
        height={height}
        accessibilityLabel={copy.app.overview.map.figure}
      >
        {/*
          The landmass, drawn once under everything. The four region fills are
          tints of the risk hue rather than opaque paint, so they need something
          behind them that is not the page. Sunken surface is what the rest of
          the app puts under a tint.
        */}
        {SUBSYSTEM_DISPLAY_ORDER.map((code) => (
          <Path
            key={`land-${code}`}
            d={SUBSYSTEM_PATH[code]}
            fill={colors.surfaceSunken}
          />
        ))}

        {SUBSYSTEM_DISPLAY_ORDER.map((code) => {
          const forecast = byCode.get(code);
          if (forecast === undefined) {
            return null;
          }
          const meta = subsystemMeta(code);
          const klass = riskClass(forecast.occurrenceProbability);
          const tone = riskColor(colors, klass);
          const isSelected = code === selected;
          const isActive = code === active;
          const anchor = SUBSYSTEM_LABEL_ANCHOR[code];
          const label = fill(copy.app.overview.map.region, {
            subsystem: meta.onsDisplayName,
            risk: copy.app.risk[klass],
            probability: f.percentPoints(
              roundProbability(forecast.occurrenceProbability),
            ),
          });

          /*
            Hover and focus are the same restrained move the rows make: the fill
            lifts a step and the outline goes from hairline to hairline-plus.
            Nothing translates, scales or pulses, so there is no motion for
            `useReducedMotion` to suppress — only the CSS transition that eases
            the colour change, which it does suppress.
          */
          const raised = isActive || isSelected;
          const handlers =
            Platform.OS === "web"
              ? ({
                  tabIndex: 0,
                  // **No `role: "button"` here, and that is the whole of a bug
                  // this shipped with.** `react-native-svg` renders `Path`
                  // through react-native-web's `createElement`, and
                  // `propsToAccessibilityComponent` turns `role`/
                  // `accessibilityRole` into the *host element*: `"button"`
                  // produced a real `<button>` carrying `d`, `fill` and
                  // `stroke` as unknown attributes. A `<button>` draws no
                  // geometry, so all four regions vanished and the map showed
                  // only its non-interactive interior-borders path — dark grey,
                  // uncolourable and unclickable.
                  //
                  // `aria-*` and `tabIndex` do not go through that mapping, so
                  // the path stays a path and is still focusable and announced.
                  // The role is carried by `aria-pressed` plus the label, which
                  // is what a screen reader reads either way.
                  "aria-label": label,
                  "aria-pressed": isSelected,
                  onClick: () => onSelect(code),
                  onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(code);
                    }
                  },
                  onMouseEnter: () => setActive(code),
                  onMouseLeave: () => setActive(null),
                  onFocus: () => setActive(code),
                  onBlur: () => setActive(null),
                  style: {
                    cursor: "pointer",
                    ...focusRing(isActive, colors.focus, 0),
                    ...(reduced ? {} : webTransition("fill-opacity", motion.fast)),
                  },
                } as object)
              : ({
                  onPress: () => onSelect(code),
                  accessibilityRole: "button",
                  accessibilityLabel: label,
                } as object);

          return (
            <G key={code}>
              <Path
                d={SUBSYSTEM_PATH[code]}
                fill={tone.fg}
                fillOpacity={raised ? 0.72 : 0.5}
                stroke={isSelected ? colors.accent : tone.fg}
                strokeWidth={isSelected ? 3.5 : 1.5}
                strokeLinejoin="round"
                {...handlers}
              />
              {/*
                The label and glyph sit above the hit path and take no events of
                their own — a pointer that crosses the text must not read as
                leaving the region.
              */}
              <G pointerEvents="none">
                <SvgText
                  x={anchor.x}
                  y={anchor.y}
                  textAnchor="middle"
                  fontSize={38}
                  fontWeight="700"
                  fontFamily={FONT}
                  fill={isSelected ? colors.accent : colors.ink}
                >
                  {meta.short}
                </SvgText>
                <Steps
                  klass={klass}
                  x={anchor.x}
                  y={anchor.y + 34}
                  color={tone.fg}
                  dim={colors.borderStrong}
                />
              </G>
            </G>
          );
        })}

        {/*
          The 27 federal units, as a hairline over the four fills and under
          nothing. Subordinate on purpose: the unit of this map is the
          subsystem, and states drawn at equal weight would invite a reader to
          click one. They are here because four flat blobs are a diagram and
          Brazil-with-its-states is a map — and because the two places the
          electrical boundary cuts across the geographic one (Maranhão into N,
          Acre and Rondônia into SE/CO) are only visible as *border* lines that
          do not coincide with a fill edge.
        */}
        <Path
          d={STATE_BORDER_D}
          fill="none"
          stroke={colors.canvas}
          strokeWidth={1}
          strokeOpacity={0.45}
          pointerEvents="none"
        />
      </Svg>

      {/*
        Attribution, on the figure rather than only in a comment. IBGE's data
        is open, and open data still has a publisher.
      */}
      <Text
        style={{
          fontSize: 10,
          color: colors.inkFaint,
          marginTop: space.sm,
          textAlign: "center",
        }}
      >
        {copy.app.overview.map.source}
      </Text>
    </View>
  );
}
