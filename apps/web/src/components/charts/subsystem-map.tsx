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
 * **One map, two languages, and they must never be mistaken for each other.**
 * With a promoted model the four regions carry tomorrow's **risk class**; with
 * none — the state production is in — they carry the **settled** megawatt-hours
 * ONS has already published for the last 24 hours, which need no artifact and
 * are true either way. Both are real; they are different claims about different
 * days, and a reader who read one as the other would be badly misled. So the
 * two modes differ on four channels at once, and `paint` is a discriminated
 * union rather than a nullable row precisely so a caller cannot hand this
 * component one kind of number under the other's label:
 *
 *  1. **Hue family.** Forecast is `risk-class.tsx`'s three bins — muted, amber,
 *     red — imported and never re-derived. Observed is a single cyan ramp from
 *     `observed-scale.ts`, a hue used nowhere else on this screen. No fill
 *     either can produce is a fill the other can; `test/observed-overview.test.ts`
 *     holds that as an assertion over the whole range.
 *  2. **Scale.** Forecast is stepped, because a smooth ramp would claim the
 *     model can tell 31 % from 33 %. Observed is continuous, because a settled
 *     megawatt-hour is a measurement. The argument for each is the argument
 *     against the other, which is why they cannot be swapped.
 *  3. **What is printed inside the region.** Forecast draws the three-step risk
 *     glyph — a class, not a quantity. Observed prints the figure itself.
 *  4. **What the region says when read aloud.** The two `map.region*` strings
 *     are different sentences: one names a risk class and a probability, the
 *     other names settled energy and the window it settled over. Neither can be
 *     rendered in the other's mode.
 *
 * Colour is never the only encoding in either mode: the subsystem's short code
 * is printed on every region, and the glyph or the figure carries the magnitude
 * with the hues removed.
 *
 * **Geometry** lives in `@/lib/geo/brazil-subsystems` — source, licence,
 * projection and the simplification trade-off are all documented there.
 */

import { space, useContainerWidth, usePalette, useReducedMotion } from "@wattsteer/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import Svg, { G, Path, Text as SvgText } from "react-native-svg";
import { regionHandlers, settleArrowFocus } from "@/components/charts/region-handlers";
import { MapLegend, useRegionPaint } from "@/components/charts/region-paint";
import { useCopy } from "@/i18n";
import {
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";
import {
  BRAZIL_VIEWBOX,
  STATE_BORDER_D,
  SUBSYSTEM_LABEL_ANCHOR,
  SUBSYSTEM_PATH,
} from "@/lib/geo/brazil-subsystems";
import type { ObservedRow, OutlookRow } from "@/lib/network";

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

/**
 * Which of the two claims this map is making, and the rows behind it.
 *
 * A union and not a pair of optional props: `{ forecasts?, observed? }` has two
 * states nobody wants — neither, and both — and the second of those is a map
 * that would have to choose silently which number it was painting.
 */
export type MapPaint =
  | { readonly kind: "forecast"; readonly rows: readonly OutlookRow[] }
  | { readonly kind: "observed"; readonly rows: readonly ObservedRow[] };

/** One region, resolved to paint. Built once per render, per mode. */
export interface RegionPaint {
  /** The region's hue. Also its outline when neither selected nor focused. */
  readonly fill: string;
  /** What a screen reader says about this region. Mode-specific by design. */
  readonly label: string;
  /** Under the short code: the risk glyph, or the settled figure. */
  readonly glyph: ReactNode;
}

/**
 * How far the fill lifts for hover and for selection, per mode.
 *
 * **Forecast** paints a categorical tint, so opacity is free to carry the
 * interaction and does so over a wide range — three clearly separated steps.
 *
 * **Observed** encodes the magnitude in the hue itself, and opacity would be a
 * second, competing magnitude channel: a small region under the pointer could
 * out-read a large one beside it. So the observed range is deliberately narrow
 * — enough that a pointer produces a response, not enough to reorder the map —
 * and the figure printed on each region settles any residual ambiguity.
 */
const LIFT = {
  forecast: { rest: 0.5, active: 0.72, selected: 0.88 },
  observed: { rest: 0.8, active: 0.92, selected: 1 },
} as const;

export function SubsystemMap({
  paint,
  selected,
  hovered = null,
  onHoverChange,
  onSelect,
}: {
  /** The four rows and which claim they make. See {@link MapPaint}. */
  paint: MapPaint;
  selected: SubsystemCode;
  /**
   * The subsystem the pointer is on, held by the parent rather than here.
   *
   * Lifted because the highlight has two ends: hovering a region lights its row
   * and hovering a row lights its region. Kept in this component it could only
   * ever light one of them.
   */
  hovered?: SubsystemCode | null;
  onHoverChange?: (subsystem: SubsystemCode | null) => void;
  /** The overview's own row handler. Not a map-specific one. */
  onSelect: (subsystem: SubsystemCode) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const reduced = useReducedMotion();
  const [containerWidth, onLayout] = useContainerWidth();
  const setActive = (code: SubsystemCode | null) => onHoverChange?.(code);
  const active = hovered;
  /**
   * The region the **keyboard** is on, separate from the one the pointer is on.
   *
   * They used to be one value, and the focus ring was drawn off it — so hovering
   * with a mouse painted a focus indicator, which is not what a focus indicator
   * is for. Keyboard focus needs a visible marker and a pointer does not; the
   * pointer already has the fill lift and its own cursor.
   */
  const [focusedCode, setFocusedCode] = useState<SubsystemCode | null>(null);
  /**
   * The rendered container, so an arrow key can find the next region's path.
   *
   * `react-native-web` forwards a `View`'s ref to its host element, so this is
   * a real DOM node on web and an unused ref everywhere else.
   */
  const host = useRef<View | null>(null);
  /*
    Hand the keyboard back what it was holding. No dependency array: this has
    to run on the *mount* that follows the remount `setParams` causes, which is
    a different instance from the one the arrow was pressed on. The guard on
    `selected` keeps it from firing on a render that is not the one the arrow
    asked for, and keeps a second mounted map out of it.
  */
  useEffect(() => {
    settleArrowFocus(selected, host);
  });

  /*
    **`role="button"`, stamped on after mount, because it cannot be a prop.**

    The four region paths already carry `aria-label`, `aria-pressed` and
    `tabIndex` — and an SVG `<path>` has **no implicit ARIA role**, which makes
    both of those attributes invalid where they sit: `aria-pressed` is only
    allowed on a role that supports it, and `aria-label` is prohibited outright
    on a roleless element. Lighthouse reports it as `aria-allowed-attr` plus
    `aria-prohibited-attr` and it cost the Overview its perfect accessibility
    score; a screen reader meeting these paths is told a label it is not
    supposed to be told, on something with no role to act on.

    It could not be fixed where the problem is. The comment on `handlers` below
    records that `accessibilityRole: "button"` makes `react-native-web`'s
    `propsToAccessibilityComponent` swap the host element for a real `<button>`,
    which draws no geometry — all four regions vanish and the map is a grey
    outline. That was re-checked here rather than taken on trust, and the raw
    DOM spelling `role: "button"` was checked too, in case only the React Native
    prop went through the mapping. **It does not**: with `role` passed as a
    prop, `[data-region]` never appears in the document at all. Both spellings
    are intercepted; the attribute has to arrive after React is finished.

    So it arrives here, through the same `host` ref and the same
    `[data-region]` query `focusRegion` above already uses — scoped to this
    map's own subtree for the reason that function documents, because a second
    Overview in the stack would otherwise be two candidates. No dependency
    array, for the same reason the effect above has none: `setParams` remounts
    this component, and the stamp has to survive onto the new instance.

    Native is untouched. There the `accessibilityRole` in `handlers` is the
    right prop and does the right thing; this runs only where there is a
    document to query.
  */
  useEffect(() => {
    const container = host.current as {
      querySelectorAll?: (s: string) => unknown;
    } | null;
    const found = container?.querySelectorAll?.("[data-region]");
    if (found === undefined || found === null) {
      return;
    }
    for (const node of found as Iterable<{
      setAttribute?: (k: string, v: string) => void;
    }>) {
      node.setAttribute?.("role", "button");
    }
  });

  const width = Math.min(containerWidth > 0 ? containerWidth : MAX_WIDTH, MAX_WIDTH);
  const height = (width * BRAZIL_VIEWBOX.height) / BRAZIL_VIEWBOX.width;

  const { observedMax, painted } = useRegionPaint(paint);
  const lift = LIFT[paint.kind];

  return (
    <View ref={host} onLayout={onLayout} style={{ alignItems: "center" }}>
      <Svg
        viewBox={`0 0 ${BRAZIL_VIEWBOX.width} ${BRAZIL_VIEWBOX.height}`}
        width={width}
        height={height}
        accessibilityLabel={
          paint.kind === "forecast"
            ? copy.app.overview.map.figure
            : copy.app.overview.map.figureObserved
        }
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
          const region = painted.get(code);
          if (region === undefined) {
            return null;
          }
          const meta = subsystemMeta(code);
          const isSelected = code === selected;
          const isActive = code === active;
          const anchor = SUBSYSTEM_LABEL_ANCHOR[code];

          /*
            Hover and focus are the same restrained move the rows make: the fill
            lifts a step and the outline goes from hairline to hairline-plus.
            Nothing translates, scales or pulses, so there is no motion for
            `useReducedMotion` to suppress — only the CSS transition that eases
            the colour change, which it does suppress.

            The `raised` boolean that stood here folded hover and selection into
            one step. It is now three steps on `fillOpacity` below, because the
            two states stopped being interchangeable the day a click selected
            instead of navigating: hover is where the pointer is *now*, and
            selection is what the four panels underneath are about.
          */
          const isFocused = code === focusedCode;
          return (
            <G key={code}>
              <Path
                d={SUBSYSTEM_PATH[code]}
                fill={region.fill}
                // Three steps, not two. Hover and selection used to share one
                // lift, so the moment the pointer left, the selected region
                // dropped back to looking exactly like the other three — and
                // clicking a region now re-points four panels rather than
                // navigating, which makes a selection that does not persist
                // visually a change with nothing on screen to attribute it to.
                fillOpacity={
                  isSelected ? lift.selected : isActive ? lift.active : lift.rest
                }
                // Focus outranks selection, because a keyboard user moving
                // across the map has to be able to see where they are even
                // while the selected region stays selected behind them.
                stroke={
                  isFocused ? colors.focus : isSelected ? colors.accent : region.fill
                }
                strokeWidth={isFocused || isSelected ? 3.5 : 1.5}
                strokeLinejoin="round"
                {...regionHandlers({
                  code,
                  label: region.label,
                  selected,
                  reduced,
                  onSelect,
                  setActive,
                  setFocusedCode,
                })}
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
                {region.glyph}
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

      <MapLegend paint={paint} observedMax={observedMax} />

      {/*
        The arrow keys are a real affordance now, so they are written down.
        Undiscoverable keyboard behaviour is behaviour a sighted keyboard user
        finds by accident and a mouse user never finds at all.
      */}
      <Text
        style={{
          fontSize: 10,
          color: colors.inkFaint,
          marginTop: space.sm,
          textAlign: "center",
        }}
      >
        {copy.app.overview.map.keyboardNote}
      </Text>

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
