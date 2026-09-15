/**
 * "◉ Falar" — the header control, right of `PT / EN`.
 *
 * `docs/plans/voice-copilot.md` §5.2 puts it there and rules out the two
 * alternatives:
 *
 * > **It is not a nav item and there is no route for it.** […] a `/voice` route
 * > would put voice *beside* the four modes, when its whole value is sitting
 * > *across* them. Adding it to the tab row would also break `sharedParams`,
 * > which is built on the four screens being four views of one selection.
 *
 * **Full label, not a bare microphone.** §5.2 again: *"discoverability matters
 * for a demo and a lone icon reads as decoration."* On a narrow header it
 * collapses to the orb and the dock's idle pill carries the label instead,
 * which is the one place in this feature where the same word appearing twice
 * would be the wrong answer — a header button and a floating pill both saying
 * "Pergunte ao WattSteer" is two invitations to one thing.
 *
 * **It renders nothing when voice is not configured.** Same rule as the dock,
 * and it has to be the same rule in both places or a deployment without a key
 * grows a header button that opens nothing. `availability` is `present` only
 * after a credential has actually been minted, so before the first press the
 * trigger is rendered on the `unknown` state — which is why `unknown` renders
 * it and `absent` does not: a reader has to be able to press it once for the
 * app to find out which of the two this deployment is.
 */

import { focusRing, radius, space, type, usePalette } from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { useServing } from "@/components/app/use-serving";
import { useCopy } from "@/i18n";
import { useVoiceAgent } from "./use-voice-agent";
import { VoiceOrb } from "./voice-orb";

export function VoiceTrigger({ compact = false }: { compact?: boolean }) {
  const colors = usePalette();
  const copy = useCopy();
  const agent = useVoiceAgent();
  const serving = useServing();

  /*
    **Absent before the first press, not after it.**

    The provider still latches `absent` on `VOICE_NOT_CONFIGURED`, and that is
    the authority — but learning it that way means *minting a credential to
    discover there is no key to mint one with*. On a deployment with no
    `XAI_API_KEY` the control rendered, a reader pressed it, a request went out,
    and nothing visible happened. A dead control that spent a rate-limit token
    to stay dead, which is the worst of both readings of "the dock is absent
    rather than broken".

    `/v1/meta` now says whether a session can be minted at all, and the app
    already reads that document once before first paint for the lane state. So
    the control is simply not rendered on an instance that cannot honour it, and
    the press-to-discover path remains only as the late authority for the case
    the flag cannot cover: a key that exists at page load and is revoked before
    the reader presses.

    `reading` renders the trigger. A flash of a control that then disappears is
    better than a reader who never learns the feature exists because the meta
    read was slow.
  */
  const configuredByMeta = serving.status !== "known" || serving.voiceConfigured;
  if (agent.availability === "absent" || !configuredByMeta) {
    return null;
  }

  const live = agent.status !== "idle" && agent.status !== "error";

  return (
    <Pressable
      testID="voice-trigger"
      accessibilityRole="button"
      accessibilityLabel={copy.app.voice.trigger}
      accessibilityHint={copy.app.voice.triggerHint}
      // `aria-pressed`, because this is a toggle and a reader using a screen
      // reader has no other way to know a session is already open — the orb's
      // motion is the sighted reader's version of the same fact.
      aria-pressed={live}
      onPress={live ? agent.expand : agent.open}
      style={(state) => {
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: live ? colors.accent : colors.border,
          backgroundColor: hovered ? colors.surfaceSunken : "transparent",
          paddingHorizontal: compact ? 8 : 12,
          paddingVertical: 5,
          // The focus ring lands on this `Pressable` — a `View` with a border
          // radius — and never on the orb inside it. An `outline` on an SVG is
          // drawn around its bounding box, which on this repo's map painted a
          // rectangle across half of Brazil; the orb is built from `View`s for
          // the same reason, so there is no SVG here to get it wrong twice.
          ...focusRing(focused, colors.focus, 2),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        };
      }}
    >
      <VoiceOrb status={agent.status} level={agent.level} size={16} />
      {compact ? null : (
        <Text style={{ ...type.caption, color: live ? colors.onAccentSoft : colors.ink }}>
          {copy.app.voice.trigger}
        </Text>
      )}
      {/* Keeps the compact form a circle rather than a squashed pill. */}
      {compact ? <View style={{ width: 0 }} /> : null}
    </Pressable>
  );
}
