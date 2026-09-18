/**
 * Brazil's four subsystems, draped on the globe.
 *
 * ## What this is, beside `subsystem-map.tsx`
 *
 * The SVG map is the product's workhorse: it is 32 kB, it draws at any size, it
 * works on native, and it is what every panel in `/app` uses. This is the
 * console's map and only the console's — a scene rather than a figure. It buys
 * three things the flat map cannot have, and costs a 22 MB static payload and an
 * ion account, which is why it is not used anywhere else:
 *
 *  - **Where the country is.** A region lit on a black rectangle says which of
 *    four shapes curtailed. The same region lit over the São Francisco basin,
 *    with the coast and the Atlantic beside it, says where.
 *  - **Night lights as load.** The base imagery is Earth at Night, so the demand
 *    the grid exists to serve is visible under the regions that are curtailing
 *    it — the Southeast's sprawl against the Northeast's thin coastal strand.
 *    That contrast is the argument the whole product makes, and this is the only
 *    screen that makes it without a sentence.
 *  - **Terrain.** Not decoration: the Northeast's curtailment is a plateau-and-
 *    coast story, and the escarpment is on the globe.
 *
 * ## The boundaries are still electrical
 *
 * The one thing a satellite basemap actively obscures is that ONS's subsystems
 * are not geographic regions — Maranhão is in Norte, Rondônia is in
 * Sudeste/Centro-Oeste. So the polygons drawn here come from
 * `lib/geo/brazil-lonlat.ts`, which inverts the flat map's own projection rather
 * than re-grouping federal units a second time. There is one grouping in the
 * product and both maps read it. See that module's header.
 *
 * ## Nothing here is invented
 *
 * The callout over each region carries the figure and the risk class its row
 * already holds, from `MapPaint` — the same union the SVG map takes, so the two
 * cannot disagree about what is being painted. There are no flow arrows, no
 * plant markers and no substations on this globe, and their absence is the
 * point: interchange and plant siting are not served by any route today, and a
 * globe is exactly the surface on which a plausible-looking arrow would be
 * believed.
 */

import { radius, space, type, usePalette } from "@wattsteer/ui";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useCopy, useFormat } from "@/i18n";
import {
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";
import { SUBSYSTEM_ANCHOR } from "@/lib/geo/brazil-geometry";
import { subsystemRingsFlat, unproject } from "@/lib/geo/brazil-lonlat";
import { clearSavedView, type MapView, readSavedView, saveView } from "@/lib/map-view";
import type { OutlookRow } from "@/lib/network";
import { type CesiumNamespace, cesiumAvailable, loadCesium } from "./cesium-loader";
import { riskColor } from "./risk-color";

/**
 * Where the camera sits when the scene opens.
 *
 * South of the country and high enough that the limb and the atmosphere are in
 * frame above it — the framing the console is composed for. `pitch` is the one
 * value worth understanding: at −90° this is a flat map with extra steps, and
 * the obliqueness is what makes the terrain and the night lights read at all.
 */
const HOME = {
  /** Brazil's rough centroid — what the camera looks at, not where it sits. */
  longitude: -52,
  latitude: -16,
  headingDeg: 0,
  pitchDeg: -34,
  /**
   * Metres from that point.
   *
   * Tuned against screenshots rather than reasoned from the country's span. At
   * 7.6 Mm Brazil sat in the lower third and read as a detail of a planet,
   * which is the failure mode of every globe used as a map; at 5.0 Mm Rio
   * Grande do Sul fell off the bottom of the stage and took Sul's callout with
   * it — the one region on the screen whose figure was then unreachable. This
   * fits all four subsystems with the limb and the atmosphere still in frame.
   */
  rangeMetres: 6_500_000,
} as const;

/**
 * Opacity of a region's fill, by state.
 *
 * Higher than the flat map's, because the surface underneath is different: the
 * SVG map fills over a flat canvas, and these sit over satellite imagery whose
 * own greens and browns compete with the tint. At the flat map's values the
 * four regions read as a pale wash over Brazil rather than as four states of a
 * grid.
 */
const FILL_ALPHA = { rest: 0.36, hovered: 0.56, selected: 0.82 } as const;

/** The callout's box, and the margin it keeps from the stage's edges. */
const CARD_WIDTH = 150;
const CARD_HEIGHT = 84;
const CARD_INSET = 10;

/** How far one press of the zoom control moves the camera. */
const ZOOM_STEP_METRES = 900_000;

/**
 * Where each region's card sits relative to the point it names, in pixels.
 *
 * Anchors are interior points — the spot in each region furthest from its own
 * borders — which is right for a printed label and wrong for a 168 px card:
 * Norte's and Sudeste's interior points are about 200 km apart on screen at
 * this altitude, so cards centred on them overlap and the largest figure on the
 * screen ends up underneath the smallest. The offsets push each card outward,
 * in the direction that region has room in.
 */
const CALLOUT_OFFSET: Record<SubsystemCode, { x: number; y: number }> = {
  N: { x: -128, y: -86 },
  NE: { x: 132, y: -54 },
  SE: { x: -132, y: 54 },
  S: { x: 76, y: 78 },
};

/**
 * Point the camera at Brazil.
 *
 * Framed by looking *at* the country from a distance rather than by placing the
 * camera at a guessed latitude and tilting it. `lookAt` takes a target and an
 * offset, so the country stays centred whatever the pitch is — with `setView`
 * the two are coupled, and every adjustment to the tilt slid Brazil off the
 * frame and had to be chased with a new latitude.
 *
 * `lookAtTransform(IDENTITY)` immediately afterwards releases the reference
 * frame the call installs. Without it the camera stays locked to that point and
 * the reader cannot pan away from it.
 */
function frameBrazil(viewer: any, Cesium: CesiumNamespace, saved?: MapView | null): void {
  /*
    A saved camera is restored exactly, not approximated: `lookAt` takes a target
    and an offset, which cannot express a view a reader panned to. `setView`
    takes the camera's own position and orientation, which is what was saved.
  */
  if (saved) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        saved.longitude,
        saved.latitude,
        saved.height,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(saved.heading),
        pitch: Cesium.Math.toRadians(saved.pitch),
        roll: 0,
      },
    });
    return;
  }
  viewer.camera.lookAt(
    Cesium.Cartesian3.fromDegrees(HOME.longitude, HOME.latitude),
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(HOME.headingDeg),
      Cesium.Math.toRadians(HOME.pitchDeg),
      HOME.rangeMetres,
    ),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

interface Callout {
  readonly code: SubsystemCode;
  readonly x: number;
  readonly y: number;
  /** Behind the horizon: the anchor is on the far side of the earth. */
  readonly occluded: boolean;
}

export function CesiumGlobe({
  rows,
  selected,
  hovered = null,
  onHoverChange,
  onSelect,
  onFailed,
}: {
  /**
   * The forecast rows, which is the only paint this globe takes.
   *
   * Narrower than `MapPaint` on purpose. The flat map serves two screens and
   * must paint a settled magnitude as well as a risk class; this one sits on a
   * dashboard whose subject is tomorrow, and a globe that could be showing
   * either would need a legend to say which — on the one surface where a reader
   * is least likely to look for one.
   */
  rows: readonly OutlookRow[];
  selected: SubsystemCode;
  hovered?: SubsystemCode | null;
  onHoverChange?: (subsystem: SubsystemCode | null) => void;
  onSelect: (subsystem: SubsystemCode) => void;
  /**
   * The globe could not load at all — a 404 on the distribution, a blocked
   * script, a browser with no WebGL.
   *
   * Reported rather than absorbed. Returning `null` on failure left the caller
   * drawing a black box of the stage's minimum height with the ion credit in
   * the corner and nothing in it: a blank where a map should be, with no stated
   * reason, which is the one thing `CONTEXT.md` says this product never does.
   * And because the layer choice is remembered, that blank survived a reload.
   */
  onFailed?: () => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const host = useRef<View | null>(null);
  const viewerRef = useRef<any>(null);
  const cesiumRef = useRef<CesiumNamespace | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [callouts, setCallouts] = useState<Callout[]>([]);
  /*
    Whether this map opens on a view the reader chose. Initialised from the URL
    and from storage, so the control shows the state it is in before anybody
    touches it.
  */
  const [locked, setLocked] = useState(() => readSavedView() !== null);
  /*
    The stage's own size, so a card can be kept inside it.

    Without this, Sul's card hung off the bottom edge of the panel at every
    viewport short enough to matter: the anchor is a point on a globe and knows
    nothing about the box the globe is drawn in, so a card centred on it will
    leave that box whenever the anchor comes within half a card of the edge.
  */
  const [stage, setStage] = useState({ width: 0, height: 0 });

  /*
    The handlers are read through a ref inside Cesium's own event callbacks,
    which are registered once for the life of the viewer. Closing over the props
    directly would pin the first render's `onSelect`, and the selection would
    stop working the moment the parent re-rendered with a new one.
  */
  const handlers = useRef({ onSelect, onHoverChange, onFailed });
  handlers.current = { onSelect, onHoverChange, onFailed };

  // ---------------------------------------------------------------- the viewer

  useEffect(() => {
    if (Platform.OS !== "web" || !cesiumAvailable()) {
      return;
    }
    let disposed = false;

    loadCesium()
      .then(async (Cesium) => {
        const element = host.current as unknown as HTMLElement | null;
        if (disposed || !element) {
          return;
        }
        cesiumRef.current = Cesium;

        const viewer = new Cesium.Viewer(element, {
          // Every widget off. This is a scene inside a product's own chrome,
          // and Cesium's default furniture — a clock, a base-layer picker, a
          // geocoder searching the world — belongs to a GIS tool, not here.
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          navigationHelpButton: false,
          sceneModePicker: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
          scene3DOnly: true,
          /*
            Cesium World Imagery, the asset every ion token carries.

            Earth at Night (ion asset 3812) was the first choice and is the
            better picture for this product — city lights are the load the grid
            exists to serve, drawn under the regions curtailing it. It is not in
            a default token's asset list and answers 404, which Cesium reports
            by rendering a globe of pure starfield: a scene that looks like a
            layout failure and is an authorisation one. Adding 3812 to the
            token's assets in ion is all it would take to switch back.
          */
          baseLayer: Cesium.ImageryLayer.fromProviderAsync(
            Cesium.IonImageryProvider.fromAssetId(2),
          ),
        });

        /*
          Daylight imagery, graded down to sit inside a dark product.

          Untouched, world imagery is a bright blue-and-green marble that
          out-shouts every panel around it and leaves the four risk fills — the
          only thing on the globe carrying information — reading as a tint on a
          postcard. Dimmed and desaturated, the basemap becomes ground and the
          regions become figure, which is the whole job of the composition.
        */
        const base = viewer.imageryLayers.get(0);
        if (base) {
          base.brightness = 0.62;
          base.saturation = 0.72;
          base.contrast = 1.12;
          base.gamma = 0.9;
        }

        viewer.scene.globe.enableLighting = false;
        viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#04060D");
        viewer.scene.globe.showGroundAtmosphere = true;
        viewer.scene.skyAtmosphere.show = true;
        viewer.scene.fog.enabled = true;
        // The Cesium wordmark is kept — ion's terms require attribution — but
        // the default credit bar sits over the bottom-left card. It is moved to
        // a container the console lays out itself.
        viewer.cesiumWidget.creditContainer.style.display = "none";

        frameBrazil(viewer, Cesium, readSavedView());

        /*
          Terrain after the viewer rather than in its options: the async
          provider would otherwise have to be awaited before anything is on
          screen, and a globe that appears late is worse than one that gains
          relief a moment after it appears.
        */
        try {
          viewer.scene.setTerrain(Cesium.Terrain.fromWorldTerrain());
        } catch {
          // Relief is an enhancement. A terrain asset the token cannot reach
          // leaves an ellipsoid, which is still the scene.
        }

        if (disposed) {
          viewer.destroy();
          return;
        }
        viewerRef.current = viewer;

        // ---- picking

        const pickCode = (position: { x: number; y: number }): SubsystemCode | null => {
          const picked = viewer.scene.pick(position);
          const id = picked?.id?.id;
          return typeof id === "string" && id.startsWith("subsystem:")
            ? (id.slice("subsystem:".length) as SubsystemCode)
            : null;
        };

        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((movement: any) => {
          const code = pickCode(movement.position);
          if (code) {
            handlers.current.onSelect(code);
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
        handler.setInputAction((movement: any) => {
          handlers.current.onHoverChange?.(pickCode(movement.endPosition));
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        // ---- callout tracking

        const anchors = SUBSYSTEM_DISPLAY_ORDER.map((code) => {
          const { x, y } = SUBSYSTEM_ANCHOR[code];
          const [longitude, latitude] = unproject(x, y);
          return {
            code,
            position: Cesium.Cartesian3.fromDegrees(longitude, latitude),
          };
        });
        const occluder = new Cesium.EllipsoidalOccluder(
          Cesium.Ellipsoid.WGS84,
          viewer.scene.camera.position,
        );

        viewer.scene.postRender.addEventListener(() => {
          occluder.cameraPosition = viewer.scene.camera.position;
          const next: Callout[] = [];
          for (const anchor of anchors) {
            const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
              viewer.scene,
              anchor.position,
            );
            if (!screen) {
              continue;
            }
            next.push({
              code: anchor.code,
              x: screen.x,
              y: screen.y,
              occluded: !occluder.isPointVisible(anchor.position),
            });
          }
          /*
            Committed only when something moved by a whole pixel. `postRender`
            fires every frame whether or not the camera did anything, and
            setting state on each of those would re-render four cards at 60 Hz
            for the life of the screen.
          */
          setCallouts((previous) =>
            previous.length === next.length &&
            previous.every(
              (card, index) =>
                Math.abs(card.x - (next[index] as Callout).x) < 1 &&
                Math.abs(card.y - (next[index] as Callout).y) < 1 &&
                card.occluded === (next[index] as Callout).occluded,
            )
              ? previous
              : next,
          );
        });

        setReady(true);
      })
      .catch(() => {
        if (!disposed) {
          setFailed(true);
          handlers.current.onFailed?.();
        }
      });

    return () => {
      disposed = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
      setReady(false);
    };
  }, []);

  // --------------------------------------------------------------- the regions

  /*
    Entities are rebuilt rather than mutated when the paint changes. Four
    polygons is nothing to rebuild, and the alternative — holding a handle to
    each and reaching into its material — is the kind of imperative state that
    drifts out of step with the props it is meant to mirror.
  */
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!(viewer && Cesium && ready)) {
      return;
    }
    viewer.entities.removeAll();

    for (const row of rows) {
      const code = row.subsystem as SubsystemCode;
      const tone = riskColor(colors, row.riskClass);
      const alpha =
        code === selected
          ? FILL_ALPHA.selected
          : code === hovered
            ? FILL_ALPHA.hovered
            : FILL_ALPHA.rest;
      const fill = Cesium.Color.fromCssColorString(tone.fg).withAlpha(alpha);

      for (const ring of subsystemRingsFlat(code)) {
        viewer.entities.add({
          // The picked id. Every ring of one subsystem shares it, so clicking
          // Marajó selects Norte like clicking the mainland does.
          id: `subsystem:${code}:${viewer.entities.values.length}`,
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(ring),
            material: fill,
            // Draped on the terrain rather than floated above it, so the fill
            // follows the relief instead of cutting through a plateau.
            classificationType: Cesium.ClassificationType.TERRAIN,
          },
        });
        viewer.entities.add({
          id: `subsystem:${code}:outline:${viewer.entities.values.length}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(ring),
            clampToGround: true,
            width: code === selected ? 7 : 4,
            material: new Cesium.PolylineGlowMaterialProperty({
              color: Cesium.Color.fromCssColorString(tone.fg).withAlpha(1),
              glowPower: code === selected ? 0.35 : 0.25,
            }),
          },
        });
      }
    }
  }, [ready, rows, selected, hovered, colors]);

  // ----------------------------------------------------------------- rendering

  if (Platform.OS !== "web" || !cesiumAvailable() || failed) {
    return null;
  }

  const rowFor = (code: SubsystemCode) => rows.find((row) => row.subsystem === code);

  /** Keep a card fully inside the stage, once the stage has been measured. */
  const clamp = (value: number, size: number, extent: number) =>
    extent === 0
      ? value
      : Math.max(CARD_INSET, Math.min(value, extent - size - CARD_INSET));

  return (
    <View
      onLayout={(event) =>
        setStage({
          width: event.nativeEvent.layout.width,
          height: event.nativeEvent.layout.height,
        })
      }
      style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
    >
      <View
        ref={host}
        style={{
          flex: 1,
          minHeight: 0,
          backgroundColor: "#04060D",
        }}
      />

      {/*
        Zoom and reframe, because a globe a reader cannot move is a picture.

        Drag and scroll already work — they are Cesium's — but neither is
        discoverable and neither is reachable from a keyboard. These are
        buttons, so they are both. `reset` matters more than the two zooms: a
        reader who has spun the earth has no other way back to the framing the
        screen was composed for, and hunting for Brazil on a globe is not a
        thing a dashboard should ever ask.
      */}
      {ready ? (
        <View
          style={{
            ...(Platform.OS === "web" ? ({ position: "absolute" } as object) : null),
            right: space.md,
            bottom: space.md,
            gap: 6,
          }}
        >
          <GlobeButton
            label="+"
            hint={copy.app.grid.zoomIn}
            onPress={() => viewerRef.current?.camera.zoomIn(ZOOM_STEP_METRES)}
          />
          <GlobeButton
            label="−"
            hint={copy.app.grid.zoomOut}
            onPress={() => viewerRef.current?.camera.zoomOut(ZOOM_STEP_METRES)}
          />
          <GlobeButton
            label="⌖"
            hint={copy.app.grid.recentre}
            onPress={() => {
              const viewer = viewerRef.current;
              const Cesium = cesiumRef.current;
              if (viewer && Cesium) {
                // Deliberately *without* the saved view: this is how a reader
                // gets back to the framing the screen was composed for, so it
                // must not restore the one they locked.
                frameBrazil(viewer, Cesium);
              }
            }}
          />
          {/*
            **Lock this view.**

            Takes the camera the reader arrived at and makes it the one the map
            opens on — in this browser, and in a link they can send. Pressing it
            again clears the lock: a control that can only ever set something is
            a control nobody can undo.
          */}
          <GlobeButton
            label={locked ? "\u2693" : "\u2691"}
            hint={locked ? copy.app.grid.unlockView : copy.app.grid.lockView}
            onPress={() => {
              const viewer = viewerRef.current;
              const Cesium = cesiumRef.current;
              if (!(viewer && Cesium)) {
                return;
              }
              if (locked) {
                clearSavedView();
                setLocked(false);
                return;
              }
              const carto = viewer.camera.positionCartographic;
              const link = saveView({
                longitude: Cesium.Math.toDegrees(carto.longitude),
                latitude: Cesium.Math.toDegrees(carto.latitude),
                height: carto.height,
                heading: Cesium.Math.toDegrees(viewer.camera.heading),
                pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
              });
              /*
                Copied at the moment it is made, because that is the moment it
                is good: `cam` is written straight to the address bar rather
                than through the router, so the router's next navigation — any
                chip press — rebuilds the query without it. Local storage is the
                half that survives; the clipboard is how the link gets out of
                the browser before the next press.
              */
              void navigator.clipboard?.writeText(link).catch(() => undefined);
              setLocked(true);
            }}
          />
        </View>
      ) : null}

      {/*
        The legend names the three risk bins and nothing else.

        The dashboard this is modelled on puts an interchange-flow key here.
        There are no flows on this globe, so a legend for them would be a key to
        a layer that does not exist — and the three bins are the one thing on
        the scene a reader genuinely has to be told, because the fill colour is
        the only channel carrying them.
      */}
      {ready ? (
        <View
          pointerEvents="none"
          style={{
            ...(Platform.OS === "web" ? ({ position: "absolute" } as object) : null),
            left: space.md,
            bottom: 34,
            gap: 5,
            padding: space.sm,
            borderRadius: radius.md,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: "rgba(12,13,18,0.7)",
            ...(Platform.OS === "web"
              ? ({ backdropFilter: "blur(8px)" } as object)
              : null),
          }}
        >
          <Text style={{ ...type.caption, color: colors.inkFaint }}>
            {copy.app.grid.legendTitle}
          </Text>
          {(["high", "elevated", "low"] as const).map((klass) => (
            <View
              key={klass}
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  backgroundColor: riskColor(colors, klass).fg,
                }}
              />
              <Text style={{ ...type.caption, color: colors.inkMuted }}>
                {copy.app.risk[klass]}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {/*
        The callouts are DOM overlays rather than Cesium billboards, and that is
        a design decision rather than a convenience: a billboard is an image, so
        every figure on it would be rasterised at one size, unselectable,
        invisible to a screen reader and outside the product's type scale. These
        are the same components the rest of `/app` is built from, positioned by
        the camera.
      */}
      <View
        pointerEvents="box-none"
        style={{
          ...(Platform.OS === "web" ? ({ position: "absolute" } as object) : null),
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      >
        {callouts.map((card) => {
          const row = rowFor(card.code);
          if (!row || card.occluded) {
            return null;
          }
          const meta = subsystemMeta(card.code);
          const tone = riskColor(colors, row.riskClass);
          const isSelected = card.code === selected;
          return (
            <Pressable
              key={card.code}
              onPress={() => onSelect(card.code)}
              onHoverIn={() => onHoverChange?.(card.code)}
              onHoverOut={() => onHoverChange?.(null)}
              accessibilityRole="button"
              aria-pressed={isSelected}
              style={{
                ...(Platform.OS === "web" ? ({ position: "absolute" } as object) : null),
                // Centred on the anchor horizontally, lifted clear of it
                // vertically so the card annotates the region rather than
                // covering the point it names.
                left: clamp(
                  card.x - CARD_WIDTH / 2 + CALLOUT_OFFSET[card.code].x,
                  CARD_WIDTH,
                  stage.width,
                ),
                top: clamp(
                  card.y - 32 + CALLOUT_OFFSET[card.code].y,
                  CARD_HEIGHT,
                  stage.height,
                ),
                width: CARD_WIDTH,
                gap: 2,
                paddingVertical: space.sm,
                paddingHorizontal: space.md,
                borderRadius: radius.md,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: isSelected ? tone.fg : colors.border,
                backgroundColor: "rgba(12,13,18,0.86)",
                ...(Platform.OS === "web"
                  ? ({
                      backdropFilter: "blur(10px)",
                      boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
                    } as object)
                  : null),
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: radius.pill,
                    backgroundColor: tone.fg,
                  }}
                />
                <Text style={{ ...type.caption, color: colors.ink }} numberOfLines={1}>
                  {meta.short}
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
                <Text
                  style={{
                    fontSize: 20,
                    lineHeight: 24,
                    fontWeight: "600",
                    color: colors.ink,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {f.compact(row.dailyEnergy.p50)}
                </Text>
                <Text style={{ ...type.caption, color: colors.inkFaint }}>MWh</Text>
              </View>
              <Text style={{ ...type.caption, color: tone.fg }} numberOfLines={1}>
                {`${copy.app.grid.riskLabel}: ${copy.app.risk[row.riskClass]}`}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * One square control over the globe.
 *
 * Its own component rather than three copies because the hit target, the
 * contrast against a moving basemap and the accessible name are the parts worth
 * getting right once.
 */
function GlobeButton({
  label,
  hint,
  onPress,
}: {
  label: string;
  hint: string;
  onPress: () => void;
}) {
  const colors = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={hint}
      style={{
        width: 34,
        height: 34,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: "rgba(12,13,18,0.78)",
        ...(Platform.OS === "web"
          ? ({ backdropFilter: "blur(8px)", cursor: "pointer" } as object)
          : null),
      }}
    >
      <Text style={{ fontSize: 15, lineHeight: 18, color: colors.ink }}>{label}</Text>
    </Pressable>
  );
}
