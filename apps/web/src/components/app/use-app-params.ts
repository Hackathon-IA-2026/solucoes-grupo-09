/**
 * The React binding for the URL selection. Split from `params.ts` so the
 * parsing — the part with rules worth testing — stays importable without
 * pulling in expo-router and, through it, all of React Native.
 */

import { router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { type AppParams, parseAppParams, writeParams } from "./params";

export function useAppParams(): AppParams & {
  setParams: (next: Partial<Omit<AppParams, "date">>) => void;
} {
  const raw = useLocalSearchParams();
  const params = parseAppParams(raw);
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
  const setParams = useCallback((next: Partial<Omit<AppParams, "date">>) => {
    router.setParams(writeParams(next));
  }, []);
  return { ...params, setParams };
}

export {
  type AppParams,
  gateProfileOf,
  parseAppParams,
  sharedParams,
  writeParams,
} from "./params";
