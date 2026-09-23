/**
 * The React binding for the URL selection. Split from `params.ts` so the
 * parsing — the part with rules worth testing — stays importable without
 * pulling in expo-router and, through it, all of React Native.
 */

import { latestTargetDate } from "@wattsteer/core";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import { runOf, servingGate } from "@/lib/serving-run";
import { type AppParams, parseAppParams, writeParams } from "./params";
import { useServing } from "./use-serving";

/**
 * What the address bar says, for the keys the router did not hand us.
 *
 * **On a cold load of the static export the router hands us nothing**, and that
 * was quietly fatal to the premise this whole app is built on. `params.ts`
 * opens with it:
 *
 * > The product is **public, read-only, with no accounts**. The URL is the only
 * > place cross-screen state can live that survives a reload or a paste into
 * > Slack.
 *
 * Measured on a real export: `/app?subsystem=S` rendered with **NE** selected —
 * the default — while `location.search` read `?subsystem=S` the whole time. So
 * the browser had the selection and the screen did not. Every shared link was
 * broken, on a product whose Mitigate and Time Machine screens tell the reader
 * in as many words that "the address bar is the scenario" and "this link is the
 * entire state". `useGlobalSearchParams` does not move it either.
 *
 * The router is still asked first and still wins, because after a client-side
 * `setParams` it is the authority and it is what re-renders. This only fills
 * the keys it left absent, which on a cold load is all of them and after a
 * navigation is none.
 *
 * Web-only by construction: there is no `location` on native, where a route's
 * params arrive through the navigator and this gap does not exist.
 */
function fromAddressBar(): Record<string, string> {
  if (Platform.OS !== "web" || typeof location === "undefined") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(location.search)) {
    out[key] = value;
  }
  return out;
}

export function useAppParams(): AppParams & {
  setParams: (next: Partial<AppParams>) => void;
} {
  const raw = useLocalSearchParams();
  // The router's answer wins wherever it has one; the address bar supplies the
  // rest. Spread order is the whole of that rule.
  // One re-render after hydration, and it is the whole of the cold-load fix.
  //
  // The static export prerenders `/app` at build time, where there is no URL to
  // read, so the HTML ships with the defaults — `NE`, `12Z`, `WIND`. On a cold
  // load of `/app?subsystem=S` the hook computes `S` correctly on the client's
  // very first render, and **React's hydration does not correct an attribute
  // mismatch**: it keeps the server's markup and warns only in development. So
  // `aria-checked` stayed on NE for the life of the page while every value
  // behind it said S. Measured on a real export — the hook returned `S`, the
  // DOM reported `NE`, and clicking the same pill worked, which is what narrowed
  // it to hydration rather than to parsing.
  //
  // **The first client render must agree with the server, and only then change.**
  // Merely forcing a second render does not work, and finding out why is the
  // point of this comment: React diffs a re-render against its own *virtual*
  // tree, not against the DOM. On a cold load the client's first render already
  // computed `S`, so React's tree said `S` while the hydrated markup said `NE`,
  // and every subsequent render compared `S` to `S` and patched nothing. The DOM
  // and the app disagreed permanently, in silence.
  //
  // So the URL is deliberately *not* read on the first client render: it yields
  // the same defaults the export prerendered, hydration matches, and the effect
  // below then produces a second render whose values genuinely differ — which
  // React does apply. The cost is one frame of default selection on a deep link,
  // which is what an export with no server-side URL can honestly offer.
  // Both rules below describe exactly what the seventy lines above explain
  // this hook is *for*: a first client render that agrees with the export,
  // and a second one that does not. Deriving the value before render is the
  // version that was measured and shipped broken — React diffs a re-render
  // against its own tree, not the DOM, so the correction never lands.
  // react-doctor-disable-next-line react-doctor/rendering-hydration-no-flicker
  const [hydrated, setHydrated] = useState(false);
  // react-doctor-disable-next-line react-doctor/rendering-hydration-no-flicker
  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-initialize-state, react-hooks-js/set-state-in-effect
    setHydrated(true);
  }, []);
  const raw_ = hydrated ? { ...fromAddressBar(), ...withoutEmpty(raw) } : {};
  const serving = useServing();
  const now = new Date();
  /*
    The default run follows the lane table, and only the default.

    `params.ts` defaults to `12Z` — `gate_late` — which has never promoted on
    this deployment, so a visitor met four stated absences while a complete
    forecast sat one pill away on `00Z`. `honesty.md` forbids exactly that
    shape: never state the deployment's condition from a constant. See
    `lib/serving-run.ts` for why "promoted and usable" needs the gate's own
    schedule beside it, and why the later gate wins a tie.

    **A URL that names a run still wins.** This replaces a fallback, never a
    choice: a shared link, a pill press and the Time Machine's own deep links
    all put `run` in the address bar, and none of them is overridden here.

    Serving arrives after hydration, so this can only change a later render —
    which is the same rule the address bar follows above, and for the same
    reason.
  */
  const answering =
    serving.status === "known"
      ? servingGate(serving.lanes, latestTargetDate(now), now)
      : undefined;
  const params = parseAppParams(
    raw_,
    now,
    answering === undefined ? undefined : runOf(answering),
  );
  /*
    `writeParams`, not a cast. This used to be `next as Record<string, string>`,
    which is the whole of the `Tecnologia` chip's bug in one expression: the
    cast asserted that a domain value is already a URL value, so the chip wrote
    `technology=SOLAR` and `parseAppParams` — which reads only `solar` — put the
    reader back on Wind. The cast made the compiler agree with a claim that was
    false for exactly one field.

    Every control on the selection bar goes through this hook, so translating
    here covers all of them, and covers the next one added.
  */
  const setParams = useCallback((next: Partial<AppParams>) => {
    router.setParams(writeParams(next));
  }, []);
  return { ...params, setParams };
}

/**
 * The router's params, minus the keys it reports as absent.
 *
 * `useLocalSearchParams` can hand back a key with `undefined`, and a spread of
 * that over the address bar's value would erase it — turning the fallback above
 * into a fallback that only works when the router says nothing at all, rather
 * than one that works key by key.
 */
function withoutEmpty(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

export {
  type AppParams,
  gateProfileOf,
  parseAppParams,
  sharedParams,
  writeParams,
} from "./params";
