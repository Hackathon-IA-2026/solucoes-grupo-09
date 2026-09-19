/**
 * Fetch CesiumJS at the moment a screen needs it, and never twice.
 *
 * ## Why the library is loaded and not imported
 *
 * `scripts/vendor-cesium.ts` explains why CesiumJS is served as static files
 * rather than bundled: it resolves its Web Workers, its `Assets/` and its
 * stylesheet by URL against a global `CESIUM_BASE_URL`, which a bundler that
 * inlined it would break. This module is the other end of that decision — the
 * small amount of imperative loading a script tag needs.
 *
 * ## Why it is lazy
 *
 * The distribution is a few megabytes of JavaScript before a single tile is
 * fetched. Loading it from `+html.tsx` would put that on the landing page, the
 * legal pages and every screen in `/app`, to serve one. The console asks for it
 * on mount; nothing else in the product pays for it.
 *
 * The promise is memoised at module scope, so a remount, a second globe or a
 * React strict-mode double-invoke all join the same load instead of racing to
 * append a second `<script>` — which would re-evaluate a 4 MB library and leave
 * two `window.Cesium` objects whose classes fail each other's `instanceof`.
 */

import { BASE_PATH } from "@/lib/config";

/** Where `vendor-cesium.ts` puts the distribution, as the export serves it. */
const BASE_URL = `${BASE_PATH}/cesium/`;

/**
 * The typing is deliberately thin.
 *
 * CesiumJS ships full types, but they describe the *module*, and this loads the
 * UMD build onto `window` — so importing them to type this would pull the
 * package into the bundle, which is the one thing the whole arrangement exists
 * to avoid. The component that uses the namespace is the boundary where this
 * becomes untyped, and it is a boundary rather than a habit: nothing else in
 * the product touches it.
 */
export type CesiumNamespace = Record<string, any>;

declare global {
  interface Window {
    Cesium?: CesiumNamespace;
    CESIUM_BASE_URL?: string;
  }
}

let pending: Promise<CesiumNamespace> | null = null;

/**
 * The ion access token, from the environment.
 *
 * Absence is a real state and not a misconfiguration to throw on: a fork, a
 * preview build or a contributor without an account has none, and the console
 * answers that by drawing the SVG map instead of a broken viewer. Cesium's own
 * failure mode without a token is worse than useless — the widget renders, the
 * imagery 401s, and a reader gets a black sphere with no explanation.
 */
export const CESIUM_ION_TOKEN = process.env.EXPO_PUBLIC_CESIUM_ION_TOKEN ?? "";

/** Whether a globe can be drawn at all. */
export function cesiumAvailable(): boolean {
  return typeof document !== "undefined" && CESIUM_ION_TOKEN.length > 0;
}

function loadTag<T extends HTMLScriptElement | HTMLLinkElement>(
  element: T,
  describe: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    element.addEventListener("load", () => resolve());
    element.addEventListener("error", () =>
      reject(new Error(`CesiumJS: ${describe} failed to load`)),
    );
    document.head.append(element);
  });
}

export function loadCesium(): Promise<CesiumNamespace> {
  if (window.Cesium) {
    return Promise.resolve(window.Cesium);
  }
  if (pending) {
    return pending;
  }

  /*
    Set before the script runs, not after. Cesium reads `CESIUM_BASE_URL` while
    evaluating — it resolves the worker and asset roots at load time, not at
    first use — so assigning it afterwards produces a viewer that looks correct
    and 404s every worker the moment it draws terrain.
  */
  window.CESIUM_BASE_URL = BASE_URL;

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = `${BASE_URL}Widgets/widgets.css`;

  const script = document.createElement("script");
  script.src = `${BASE_URL}Cesium.js`;
  script.async = true;

  pending = Promise.all([
    loadTag(stylesheet, "widgets.css"),
    loadTag(script, "Cesium.js"),
  ]).then(() => {
    const cesium = window.Cesium;
    if (!cesium) {
      throw new Error("CesiumJS loaded but did not define window.Cesium");
    }
    cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;
    return cesium;
  });

  // A failed load must not be cached as a permanent refusal: the next mount
  // should be free to try again, which is what a reader pressing reload
  // expects.
  pending.catch(() => {
    pending = null;
  });

  return pending;
}
