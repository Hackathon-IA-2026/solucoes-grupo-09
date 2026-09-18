/**
 * One map, two layers: the flat SVG and the globe.
 *
 * ## Why one component and not two call sites
 *
 * The Overview and the console were each wiring a map by hand — the same
 * selection, the same hover, the same four regions — and had already drifted:
 * one had scope pills and the other did not, one could switch layers and the
 * other was fixed. A map that behaves differently on two screens of one product
 * is two maps, and a reader who learns it once has learned it once.
 *
 * So the chrome and the choice live here, and the layers underneath are
 * interchangeable. What a caller supplies is the paint and the selection; what
 * it never supplies is how a region is picked or what the pills do.
 *
 * ## Why 3D is not always offered
 *
 * The globe paints a **risk class**, which only a forecast has. When the paint
 * is observed — a settled day, the state every screen falls back to with no
 * artifact promoted — there is no risk class to colour by, so the 3D option is
 * shown disabled with the reason rather than hidden. Hiding it would make the
 * control appear and disappear with the serving state, which reads as a bug;
 * disabling it says which half of the product is missing.
 *
 * The globe also costs an ion account and a 22 MB static payload, so the flat
 * map stays the default everywhere except the console, whose whole subject is
 * the scene.
 */

import { radius, space, type, usePalette } from "@wattsteer/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { CesiumGlobe } from "@/components/charts/cesium-globe";
import { cesiumAvailable } from "@/components/charts/cesium-loader";
import { type MapPaint, SubsystemMap } from "@/components/charts/subsystem-map";
import { useCopy } from "@/i18n";
import type { RunLabel, SubsystemCode } from "@/lib/fixtures";
import { type MapLayer, readLayer, saveLayer } from "@/lib/map-view";
import { type Scope, ScopeBar } from "./scope-bar";

function LayerButton({
  label,
  active,
  disabled,
  hint,
  onPress,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  hint?: string;
  onPress: () => void;
}) {
  const colors = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint ?? label}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingVertical: 5,
        paddingHorizontal: space.sm,
        borderRadius: radius.pill,
        borderCurve: "continuous",
        borderWidth: 1,
        opacity: disabled ? 0.38 : 1,
        borderColor: active ? colors.accent : "transparent",
        backgroundColor: active ? colors.accentSoft : "transparent",
        ...(Platform.OS === "web"
          ? ({ cursor: disabled ? "not-allowed" : "pointer" } as object)
          : null),
      }}
    >
      <Text
        style={{
          ...type.caption,
          color: active ? colors.accent : colors.inkMuted,
          fontWeight: active ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function RegionMap({
  paint,
  scope,
  onScope,
  selected,
  hovered,
  onHoverChange,
  onSelect,
  run,
  runInert,
  onRun,
  defaultLayer = "2d",
  /** The widest the flat layer may draw. The globe always fills the stage. */
  flatMaxWidth = 380,
  /** The stage's floor, so the globe has somewhere to be before it loads. */
  minHeight,
  /** `true` on the console, where the map is the screen rather than a figure. */
  stage = false,
}: {
  paint: MapPaint;
  scope: Scope;
  onScope: (scope: Scope) => void;
  selected: SubsystemCode;
  hovered: SubsystemCode | null;
  onHoverChange: (code: SubsystemCode | null) => void;
  onSelect: (code: SubsystemCode) => void;
  /** The run chips, where the screen has no selection bar carrying them. */
  run?: RunLabel;
  runInert?: (run: RunLabel) => boolean;
  onRun?: (run: RunLabel) => void;
  defaultLayer?: MapLayer;
  flatMaxWidth?: number;
  minHeight?: number;
  stage?: boolean;
}) {
  const colors = usePalette();
  const copy = useCopy();
  /*
    The layer this browser last chose, falling back to the screen's default.
    Switching to 3D fetches megabytes and starts a WebGL context — a deliberate
    act, and one a reader should not have to repeat after every reload.
  */
  const [layer, setLayer] = useState<MapLayer>(() => readLayer() ?? defaultLayer);
  /*
    The globe failed to load — its distribution 404'd, its script was blocked,
    the browser has no WebGL. Held here rather than inside `CesiumGlobe`,
    because the answer is to draw the other layer and say so, and only this
    component can do either.
  */
  const [globeFailed, setGlobeFailed] = useState(false);
  const chooseLayer = (next: MapLayer) => {
    setLayer(next);
    saveLayer(next);
  };

  /*
    The globe needs a token, a browser and a forecast. Any of the three missing
    makes 3D a control that would draw nothing, so it is offered disabled with
    the reason rather than silently doing the wrong thing.
  */
  const forecast = paint.kind === "forecast";
  const globeReady = Platform.OS === "web" && cesiumAvailable();
  const canBe3d = forecast && globeReady;
  const showing3d = layer === "3d" && canBe3d && !globeFailed;

  return (
    <View
      style={{
        flex: stage ? 1 : undefined,
        minHeight: minHeight ?? undefined,
        gap: stage ? 0 : space.md,
      }}
    >
      {/*
        The controls sit over the stage on the console and above the figure on
        the Overview. Same controls, same order; what differs is whether there
        is a scene underneath them to float on.
      */}
      <View
        pointerEvents="box-none"
        style={{
          ...(stage && Platform.OS === "web"
            ? ({ position: "absolute", zIndex: 2 } as object)
            : null),
          ...(stage ? { top: space.md, left: space.md, right: space.md } : null),
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          minWidth: 0,
          gap: space.sm,
        }}
      >
        <ScopeBar
          scope={scope}
          subsystem={selected}
          run={run}
          runInert={runInert}
          onScope={onScope}
          onSubsystem={onSelect}
          onRun={onRun}
        />

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingVertical: 6,
            paddingHorizontal: space.sm,
            borderRadius: radius.lg,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: stage ? "rgba(12,13,18,0.78)" : colors.surface,
            ...(stage && Platform.OS === "web"
              ? ({ backdropFilter: "blur(10px)" } as object)
              : null),
          }}
        >
          <LayerButton
            label={copy.app.grid.layer2d}
            active={!showing3d}
            disabled={false}
            onPress={() => chooseLayer("2d")}
          />
          <LayerButton
            label={copy.app.grid.layer3d}
            active={showing3d}
            disabled={!canBe3d || globeFailed}
            hint={
              globeFailed
                ? copy.app.grid.layer3dFailed
                : canBe3d
                  ? copy.app.grid.layer3d
                  : forecast
                    ? copy.app.grid.layer3dUnavailable
                    : copy.app.grid.layer3dNeedsForecast
            }
            onPress={() => chooseLayer("3d")}
          />
        </View>
      </View>

      {/*
        **The globe needs a box; the flat map brings its own.**

        `SubsystemMap` sizes itself from its viewBox, so the container centres it
        and gets out of the way. `CesiumGlobe` is `flex: 1` in both axes — a
        WebGL canvas has no intrinsic size — so in that same centring container
        it resolved to its content width and spilled past the panel. So whenever
        the globe is the layer, the container becomes a stage: full width, an
        explicit height, and `overflow: hidden` so the canvas cannot escape it.
      */}
      <View
        style={{
          flex: stage ? 1 : undefined,
          minHeight: stage ? 0 : undefined,
          height: !stage && showing3d ? (minHeight ?? 420) : undefined,
          /*
            **Always the full column, in both layers.**

            This was `showing3d ? "100%" : undefined`, so in 2D the box
            shrink-wrapped its content and in 3D it filled — which meant the
            flat map's measured container, and therefore its drawn size,
            depended on whether the globe had ever been shown. Measured: 441 px
            on a fresh load, 760 px after a trip through 3D and back. A figure
            that changes size according to what you looked at earlier is a
            figure a reader cannot compare with yesterday's.

            Full width always, centred, and `flatMaxWidth` is what decides how
            big the map is — which is a decision, in one place.
          */
          width: "100%",
          /*
            Stretched in both layers, not centred in one of them. `SubsystemMap`
            centres its own SVG, so stretching costs nothing visually — and
            centring here made the box shrink-wrap, which is what made the flat
            map measure its own content instead of the column and come out a
            different size depending on whether the globe had been shown.
          */
          alignItems: "stretch",
          justifyContent: "center",
          ...(stage || showing3d
            ? {
                borderRadius: radius.lg,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: "#04060D",
                overflow: "hidden",
              }
            : null),
        }}
      >
        {showing3d && paint.kind === "forecast" ? (
          <CesiumGlobe
            rows={paint.rows}
            selected={selected}
            hovered={hovered}
            onHoverChange={onHoverChange}
            onSelect={onSelect}
            onFailed={() => setGlobeFailed(true)}
          />
        ) : (
          <SubsystemMap
            paint={paint}
            selected={selected}
            hovered={hovered}
            onHoverChange={onHoverChange}
            onSelect={onSelect}
            maxWidth={flatMaxWidth}
          />
        )}

        {/*
          The failure, stated. A reader who had chosen 3D and now sees the flat
          map is owed the reason — otherwise the control silently disagrees with
          what is drawn, and the remembered choice makes that permanent.
        */}
        {globeFailed ? (
          <Text
            style={{
              ...(Platform.OS === "web" ? ({ position: "absolute" } as object) : null),
              top: space.md,
              alignSelf: "center",
              maxWidth: 320,
              textAlign: "center",
              ...type.caption,
              color: colors.inkMuted,
            }}
          >
            {copy.app.grid.layer3dFailed}
          </Text>
        ) : null}
        {/* ion's terms require the attribution to be visible wherever its
            imagery is drawn; Cesium's own credit bar is hidden because it
            lands under a callout. */}
        {showing3d ? (
          <Text
            style={{
              ...(Platform.OS === "web" ? ({ position: "absolute" } as object) : null),
              bottom: space.sm,
              left: space.md,
              ...type.caption,
              color: "rgba(255,255,255,0.45)",
            }}
          >
            {copy.app.grid.attribution}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
