/**
 * A saved camera for the globe: where the map opens.
 *
 * ## Why this is not an `AppParams` field
 *
 * `params.ts` owns the selection — subsystem, run, day — which every screen
 * reads and every control writes. A camera is none of those things: it belongs
 * to one layer of one component, no other screen has an opinion about it, and
 * `locale-routes.test.ts` is right to demand that anything in `AppParams` be a
 * control with enumerable values. So it travels beside them, in the same query
 * string, parsed here.
 *
 * ## Why both the URL and the browser
 *
 * They answer different questions. The URL answers *"open where I am looking"* —
 * a link somebody sends, which is this product's only real persistence and the
 * thing `params.ts` says so in as many words. Local storage answers *"open where
 * I left it"* — the same reader, tomorrow morning, with no link to paste.
 *
 * The URL wins when both are present, because a link is somebody being
 * deliberate and a stored value is a habit.
 *
 * ## Why there is no server
 *
 * There is no user. A camera written to a table would be the view *everybody*
 * gets, which is a different feature — an operator setting the product's default
 * framing — and it needs an authenticated write this API does not have. Storing
 * it per browser claims exactly as much as it can honestly claim.
 */

/** A camera, in the units Cesium's `setView` takes back. */
export interface MapView {
  /** Degrees. */
  readonly longitude: number;
  readonly latitude: number;
  /** Metres above the ellipsoid. */
  readonly height: number;
  /** Degrees. */
  readonly heading: number;
  readonly pitch: number;
}

const STORAGE_KEY = "wattsteer.mapView";
const LAYER_KEY = "wattsteer.mapLayer";
export const VIEW_PARAM = "cam";

/** Five numbers, comma-separated, rounded to what a camera can tell apart. */
export function formatView(view: MapView): string {
  return [
    view.longitude.toFixed(3),
    view.latitude.toFixed(3),
    Math.round(view.height),
    view.heading.toFixed(1),
    view.pitch.toFixed(1),
  ].join(",");
}

/**
 * The inverse, and it refuses anything it cannot fully read.
 *
 * A half-parsed camera is worse than none: it would point the globe at a
 * plausible-looking wrong place rather than at the framing the screen was
 * composed for. Every field must be finite and in range, or the caller falls
 * back to the default view.
 */
export function parseView(raw: string | null | undefined): MapView | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parts = raw.split(",").map(Number);
  if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [longitude, latitude, height, heading, pitch] = parts as [
    number,
    number,
    number,
    number,
    number,
  ];
  const sane =
    Math.abs(longitude) <= 180 &&
    Math.abs(latitude) <= 90 &&
    height > 0 &&
    height < 6e7 &&
    Math.abs(heading) <= 360 &&
    pitch >= -90 &&
    pitch <= 90;
  return sane ? { longitude, latitude, height, heading, pitch } : null;
}

/** The camera a link asked for, then the one this browser remembers. */
export function readSavedView(): MapView | null {
  if (typeof window === "undefined") {
    return null;
  }
  const fromUrl = parseView(
    new URLSearchParams(window.location.search).get(VIEW_PARAM),
  );
  if (fromUrl !== null) {
    return fromUrl;
  }
  try {
    return parseView(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private windows, blocked site data. A reader with storage off still gets
    // the default framing, which is the whole point of having one.
    return null;
  }
}

/**
 * Write the camera to both, and hand back the link.
 *
 * `replaceState` rather than a router navigation: the camera is not a screen and
 * pushing it would put a history entry between the reader and the back button
 * every time they framed a shot.
 */
export function saveView(view: MapView): string {
  const encoded = formatView(view);
  try {
    window.localStorage.setItem(STORAGE_KEY, encoded);
  } catch {
    // Storage is a convenience here; the link below is the durable half.
  }
  const url = new URL(window.location.href);
  url.searchParams.set(VIEW_PARAM, encoded);
  window.history.replaceState(null, "", url.toString());
  return url.toString();
}

/** Forget the saved camera, so the globe opens on its composed framing again. */
export function clearSavedView(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: there is no stored value to contradict.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete(VIEW_PARAM);
  window.history.replaceState(null, "", url.toString());
}

/** Which layer the map was last showing: the flat SVG, or the globe. */
export type MapLayer = "2d" | "3d";

/**
 * The layer this browser last chose, or `null` to take the screen's default.
 *
 * Remembered because switching to 3D is a deliberate act with a visible cost —
 * it fetches a few megabytes and spins up a WebGL context — and a reader who
 * chose it and then reloaded should not have to choose again. `null` rather
 * than a default here: the *screen* owns which layer it opens on when nobody
 * has said, and this module has no opinion about that.
 */
export function readLayer(): MapLayer | null {
  try {
    const raw = window.localStorage.getItem(LAYER_KEY);
    return raw === "2d" || raw === "3d" ? raw : null;
  } catch {
    return null;
  }
}

export function saveLayer(layer: MapLayer): void {
  try {
    window.localStorage.setItem(LAYER_KEY, layer);
  } catch {
    // Private windows and blocked site data. The choice still holds for this
    // page; it simply does not outlive it.
  }
}
