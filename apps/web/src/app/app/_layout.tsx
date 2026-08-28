import { Stack } from "expo-router/stack";

/**
 * The `/app` section. Four sibling screens, no nesting — the switch between
 * them lives in `AppShell`, which every screen renders, so the native stack
 * here exists only to give each route a screen container.
 */
export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: "fade" }} />;
}
