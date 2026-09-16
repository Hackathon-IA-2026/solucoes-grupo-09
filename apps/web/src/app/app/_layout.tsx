import { Stack } from "expo-router/stack";
import { ServingProvider } from "@/components/app/use-serving";
import { BriefingHost } from "@/components/briefing/briefing-host";
import { BriefingSubjectProvider } from "@/components/briefing/briefing-subject";
import { VoiceDock } from "@/components/voice/voice-dock";
import { VoiceProvider } from "@/components/voice/voice-provider";

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
 *
 * `VoiceProvider` is here for a stronger version of that same reason, and
 * `docs/plans/voice-copilot.md` §2.2 calls it *"the one structural requirement
 * that cannot be compromised"*: **navigating is the agent's primary action**. A
 * voice session mounted per screen would tear down its WebSocket, drop the
 * microphone and cut the sentence in half every time a tool call *succeeded* —
 * the feature would break precisely when it worked.
 *
 * It sits **inside** `ServingProvider` because the agent must know whether a
 * model is promoted, and reading that from the same provider the screens read
 * is what stops the dock and the chrome badge disagreeing about it.
 *
 * `<VoiceDock />` is a **sibling of `<Stack>`**, not a child of a screen: the
 * stack's `animation: "fade"` re-animates everything inside it, so a dock in
 * there would flicker at the exact moment the agent navigates — when the one
 * element that explains *why* the screen changed has to be the still thing.
 *
 * `<BriefingHost />` is a sibling for the same reason and one more: a briefing
 * can be asked for from any of the four screens, so a stage mounted inside one
 * of them would answer only there. `BriefingSubjectProvider` is what lets it
 * still draw the mounted screen's own data — the screens publish, the host
 * renders, and nothing is fetched twice.
 *
 * And all of this is on the `/app` layout rather than the root, because the
 * tools operate on the four modes and nothing else. §9: a microphone on the
 * landing page is a gimmick with nothing behind it. A reader on `/pitch` or a
 * legal page gets no dock, no permission prompt and no session minted.
 */
export default function AppLayout() {
  return (
    <ServingProvider>
      <VoiceProvider>
        <BriefingSubjectProvider>
          <Stack screenOptions={{ headerShown: false, animation: "fade" }} />
          <VoiceDock />
          <BriefingHost />
        </BriefingSubjectProvider>
      </VoiceProvider>
    </ServingProvider>
  );
}
