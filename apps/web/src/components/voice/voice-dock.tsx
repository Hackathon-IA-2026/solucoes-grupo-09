/**
 * The dock — three sizes, bottom-right, fixed to the viewport.
 *
 * `docs/plans/voice-copilot.md` §5 sketches all three and the sketches are the
 * specification: an IDLE pill that invites, an ACTIVE pill that says what the
 * session is doing, and an EXPANDED ~400 px panel with the transcript and the
 * action card. Three, and not a drawer or a modal, for a reason the plan states
 * once and this file depends on everywhere:
 *
 * > The dashboard stays visible behind it — that is the entire point.
 *
 * ## Why it is a sibling of the `Stack` and not a child of a screen
 *
 * §2.2. The stack's `screenOptions` set `animation: "fade"`, so every screen
 * the agent opens fades in. A dock inside that subtree would fade with it —
 * which would mean that at the exact moment the agent navigates, the one
 * element on screen that is supposed to explain *why* the screen changed
 * flickers along with it. The dock has to be the still thing. It is the
 * stillness that makes an automatic navigation read as the assistant acting
 * rather than as a glitch.
 *
 * ## It never covers the primary reading column
 *
 * `layout.page` is 1280 and the dock is 380 wide with a 24 px margin. At the
 * widths where the content column is actually 1280 there is room beside it; at
 * narrower widths the dock overlaps the gutter and not the column. Below
 * ~460 px it stops being 380 wide and becomes full-width-minus-the-gutters,
 * because a fixed 380 on a 400 px viewport is a horizontal scrollbar — which
 * the repo has been bitten by before (see `app-shell.tsx`'s header comment: the
 * symptom of an overflow here is not a scrollbar, it is a truncated word).
 *
 * ## No key, no dock
 *
 * `availability !== "present"` renders `null`, and there is no fallback
 * rendering underneath it. This is §2.1's fourth non-negotiable and the reason
 * `VOICE_NOT_CONFIGURED` exists as a code separate from `VOICE_UNAVAILABLE`: an
 * instance deployed without a key must look like a product without voice, never
 * like one whose voice is broken. `availability` only becomes `present` once a
 * credential has actually been minted, so the dock is not rendered on a guess.
 */

import {
  focusRing,
  motion as motionTokens,
  radius,
  space,
  type,
  usePalette,
  useReducedMotion,
  XIcon,
} from "@wattsteer/ui";
import { useEffect, useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  type StyleProp,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { useCopy } from "@/i18n";
import {
  DOCK_NARROW_BREAKPOINT,
  DOCK_WIDTH,
  statusLabel,
  useVoiceAgent,
  type VoiceAgentState,
} from "./use-voice-agent";
import { VoiceActionCard } from "./voice-action-card";
import { VoiceOrb } from "./voice-orb";
import { VoiceTranscript } from "./voice-transcript";

/** The distance from the viewport's corner. Matches the shell's page padding. */
const DOCK_INSET = 20;

export function VoiceDock() {
  const agent = useVoiceAgent();
  if (agent.availability !== "present") {
    // Not a spinner and not a disabled button. See the header comment.
    return null;
  }
  return <Dock agent={agent} />;
}

function Dock({ agent }: { agent: VoiceAgentState }) {
  const reduced = useReducedMotion();
  const [narrow, setNarrow] = useState(false);

  /**
   * The panel's arrival, and the only animation the container itself has.
   *
   * §5.1: *"the route transition **is** the animation: the dock's action card
   * slides in as the screen changes. Nothing extra."* So this is a short rise
   * and fade on the expanded panel and nothing on the pills, which are already
   * on screen and would only flicker.
   */
  // Lazy, so the `Animated.Value` is constructed once rather than on every
  // render and discarded. The initialiser reads `agent.size` at mount, which is
  // exactly the semantics the `useRef` form had — the eager version simply paid
  // for a throwaway object each time the dock re-rendered, which it does on
  // every status change and every audio frame that clears the level throttle.
  const [rise] = useState(() => new Animated.Value(agent.size === "expanded" ? 1 : 0));
  useEffect(() => {
    if (reduced) {
      rise.setValue(1);
      return;
    }
    Animated.timing(rise, {
      toValue: agent.size === "expanded" ? 1 : 0,
      duration: motionTokens.base,
      useNativeDriver: false,
    }).start();
  }, [agent.size, reduced, rise]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") {
      return;
    }
    const query = window.matchMedia(`(max-width: ${DOCK_NARROW_BREAKPOINT}px)`);
    // Reading a browser API after mount, which this rule's own message names
    // as the case to suppress: there is no `matchMedia` during the static
    // export, so the first value has to arrive on the client.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    setNarrow(query.matches);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const shell: StyleProp<ViewStyle> = {
    // `fixed` and not `absolute`: the four screens are inside a `ScrollView`,
    // and an absolutely-positioned dock would scroll away with the content it
    // is annotating.
    position: Platform.OS === "web" ? ("fixed" as "absolute") : "absolute",
    right: DOCK_INSET,
    bottom: DOCK_INSET,
    ...(narrow ? { left: DOCK_INSET } : null),
    zIndex: 40,
    alignItems: "flex-end",
    gap: space.sm,
  };

  return (
    <View testID="voice-dock" style={shell}>
      {agent.size === "expanded" ? (
        <Animated.View
          style={{
            opacity: rise,
            transform: [
              {
                translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }),
              },
            ],
            width: narrow ? "100%" : DOCK_WIDTH,
            maxWidth: "100%",
          }}
        >
          <ExpandedPanel agent={agent} />
        </Animated.View>
      ) : (
        <DockPill agent={agent} />
      )}
    </View>
  );
}

/** IDLE and ACTIVE — the same pill, with different contents. */
function DockPill({ agent }: { agent: VoiceAgentState }) {
  const colors = usePalette();
  const copy = useCopy();
  const live = agent.status !== "idle" && agent.status !== "error";

  return (
    <View
      testID={live ? "voice-dock-active" : "voice-dock-idle"}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingLeft: space.md,
        paddingRight: space.xs,
        paddingVertical: space.xs,
        borderRadius: radius.pill,
        borderWidth: 1,
        // The lime hairline on a sunken surface — the product's own control
        // language (`MiniPill`), not a new one invented for the dock. A floating
        // circle would say "chat bubble", which §5 refuses in as many words.
        borderColor: live ? colors.accent : colors.border,
        backgroundColor: colors.surfaceSunken,
        maxWidth: "100%",
      }}
    >
      <VoiceOrb status={agent.status} level={agent.level} size={22} />
      <Pressable
        testID="voice-dock-label"
        accessibilityRole="button"
        accessibilityLabel={live ? copy.app.voice.expand : copy.app.voice.idle}
        onPress={live ? agent.expand : agent.open}
        style={(state) => {
          const { focused = false } = state as { focused?: boolean };
          return {
            borderRadius: radius.pill,
            paddingVertical: 6,
            paddingHorizontal: 4,
            ...focusRing(focused, colors.focus, 2),
            ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
          };
        }}
      >
        <Text style={{ ...type.label, color: colors.ink }} numberOfLines={1}>
          {live ? statusLabel(agent.status, copy) : copy.app.voice.idle}
        </Text>
      </Pressable>
      {live ? (
        <IconControl
          testID="voice-dock-close"
          label={copy.app.voice.close}
          onPress={agent.close}
        />
      ) : null}
    </View>
  );
}

function ExpandedPanel({ agent }: { agent: VoiceAgentState }) {
  const colors = usePalette();
  const copy = useCopy();
  const voice = copy.app.voice;
  const [typed, setTyped] = useState("");
  const denied = agent.mic === "denied";

  /**
   * Escape collapses the panel.
   *
   * On the document rather than on the panel's own `View`: a React Native
   * `View` has no `onKeyDown`, and react-native-web does not forward one — so a
   * handler written as a prop here compiles and then silently never fires,
   * which is the worst of the available outcomes for a keyboard affordance.
   * The listener is installed only while the panel is expanded, so Escape means
   * what it means everywhere else on the page the rest of the time.
   */
  const collapse = agent.collapse;
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        collapse();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [collapse]);

  return (
    <View
      testID="voice-dock-expanded"
      style={{
        gap: space.md,
        padding: space.lg,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.borderStrong,
        // An opaque surface, not a blur. §5.1 refuses glassmorphism, and the
        // practical half of that refusal is legibility: this panel sits over a
        // fan chart, and a translucent one puts a P10–P90 band behind a
        // sentence about it.
        backgroundColor: colors.surface,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <VoiceOrb status={agent.status} level={agent.level} size={20} />
        <Text
          style={{
            ...type.caption,
            letterSpacing: 1,
            color: colors.inkFaint,
            flex: 1,
          }}
        >
          {voice.panelTitle}
        </Text>
        <IconControl
          testID="voice-dock-collapse"
          label={voice.collapse}
          onPress={agent.collapse}
          glyph="minus"
        />
        <IconControl
          testID="voice-dock-close"
          label={voice.close}
          onPress={agent.close}
        />
      </View>

      <View style={{ alignItems: "center", paddingVertical: space.sm }}>
        <VoiceOrb
          status={agent.status}
          level={agent.level}
          size={64}
          accessibilityLabel={statusLabel(agent.status, copy)}
        />
        <Text style={{ ...type.caption, color: colors.inkMuted, marginTop: space.sm }}>
          {statusLabel(agent.status, copy)}
        </Text>
      </View>

      <VoiceTranscript entries={agent.transcript} />

      {agent.action === null ? null : <VoiceActionCard intent={agent.action.intent} />}

      {denied ? (
        <View testID="voice-dock-typed" style={{ gap: space.sm }}>
          <Text style={{ ...type.caption, color: colors.onWarningSoft }}>
            {voice.mic.deniedTitle}
          </Text>
          <Text style={{ ...type.bodySmall, color: colors.inkMuted }}>
            {voice.mic.deniedBody}
          </Text>
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
            <TextInput
              testID="voice-dock-typed-input"
              value={typed}
              onChangeText={setTyped}
              placeholder={voice.typed.placeholder}
              placeholderTextColor={colors.inkFaint}
              accessibilityLabel={voice.typed.label}
              onSubmitEditing={() => {
                agent.say(typed);
                setTyped("");
              }}
              style={{
                flex: 1,
                minHeight: 36,
                paddingHorizontal: space.sm,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surfaceSunken,
                color: colors.ink,
                ...type.bodySmall,
              }}
            />
            <Pressable
              testID="voice-dock-typed-send"
              accessibilityRole="button"
              accessibilityLabel={voice.typed.send}
              onPress={() => {
                agent.say(typed);
                setTyped("");
              }}
              style={(state) => {
                const { focused = false } = state as { focused?: boolean };
                return {
                  minHeight: 36,
                  justifyContent: "center",
                  paddingHorizontal: space.md,
                  borderRadius: radius.sm,
                  backgroundColor: colors.accentSoft,
                  ...focusRing(focused, colors.focus, 2),
                  ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                };
              }}
            >
              <Text style={{ ...type.label, color: colors.onAccentSoft }}>
                {voice.typed.send}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {agent.error !== null && !denied ? (
        <Text
          testID="voice-dock-error"
          style={{ ...type.caption, color: colors.inkMuted }}
        >
          {voice.status.error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A 32 px round control. Its focus is a ring on a `View`, never on an SVG.
 *
 * The glyph inside is `XIcon` — an `Svg` — and the `focusRing` is applied to
 * the `Pressable` that wraps it rather than to the icon, because a CSS
 * `outline` on an SVG element is drawn by the browser around the element's
 * **bounding box**: on this repo's subsystem map that painted a rectangle
 * across half of Brazil. The geometry that shows focus here belongs to a
 * `View`, which has a border radius the outline follows.
 */
function IconControl({
  testID,
  label,
  onPress,
  glyph = "close",
}: {
  testID: string;
  label: string;
  onPress: () => void;
  glyph?: "close" | "minus";
}) {
  const colors = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={(state) => {
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          width: 30,
          height: 30,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered ? colors.surfaceSunken : "transparent",
          ...focusRing(focused, colors.focus, 1),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        };
      }}
    >
      {glyph === "close" ? (
        <XIcon size={14} color={colors.inkMuted} strokeWidth={2} />
      ) : (
        // A rule, not an icon: there is no minus in the ported set, and a 10×1
        // `View` is a smaller thing to add than a thirty-sixth icon.
        <View style={{ width: 10, height: 1.5, backgroundColor: colors.inkMuted }} />
      )}
    </Pressable>
  );
}
