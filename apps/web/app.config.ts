import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * `app.json`, plus the one setting a build argument decides: the path prefix
 * the export is served under.
 *
 * The event's AWS instance serves each port behind `/app/<port>/`, so an
 * export built for `/` asked for `/_expo/…` and got a 403 from the proxy, and
 * the page never booted (measured on 19/09/2026). `experiments.baseUrl`
 * prefixes the bundle, the assets and expo-router's links; `BASE_PATH` in
 * `src/lib/config.ts` carries the same value to the URLs written by hand.
 * Unset, the prefix is empty and the export is the one Railway serves.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const expo = config as ExpoConfig;
  const baseUrl = process.env.EXPO_PUBLIC_BASE_PATH ?? "";
  return baseUrl ? { ...expo, experiments: { ...expo.experiments, baseUrl } } : expo;
};
