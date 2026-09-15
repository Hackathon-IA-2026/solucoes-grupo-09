import { Stack } from "expo-router/stack";
import { ServingProvider } from "@/components/app/use-serving";

/**
 * The `/app` section. Four sibling screens, no nesting — the switch between
 * them lives in `AppShell`, which every screen renders, so the native stack
 * here exists only to give each route a screen container.
 *
 * `ServingProvider` wraps the stack rather than sitting inside `AppShell`
 * because it has to outlive a screen change: the chrome badge and a screen's
 * honesty note must be two renderings of one answer, and a provider remounted
 * per screen would re-ask `/v1/meta` on every tab press and could answer the
 * two differently across a promotion.
 */
export default function AppLayout() {
  return (
    <ServingProvider>
      <Stack screenOptions={{ headerShown: false, animation: "fade" }} />
    </ServingProvider>
  );
}
