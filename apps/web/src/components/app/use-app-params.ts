/**
 * The React binding for the URL selection. Split from `params.ts` so the
 * parsing — the part with rules worth testing — stays importable without
 * pulling in expo-router and, through it, all of React Native.
 */

import { router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { type AppParams, parseAppParams } from "./params";

export function useAppParams(): AppParams & {
  setParams: (next: Partial<Omit<AppParams, "date">>) => void;
} {
  const raw = useLocalSearchParams();
  const params = parseAppParams(raw);
  const setParams = useCallback((next: Partial<Omit<AppParams, "date">>) => {
    router.setParams(next as Record<string, string>);
  }, []);
  return { ...params, setParams };
}

export {
  type AppParams,
  gateProfileOf,
  parseAppParams,
  sharedParams,
} from "./params";
