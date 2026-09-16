/**
 * The `/app` chrome: one header, one context bar, four screens.
 *
 * Navigation is a flat four-way switch rather than a hierarchy, because the
 * screens are four questions about the same selection ("what will happen",
 * "why", "what could we do", "what would it have been worth") and none of them
 * is a child of another. The context bar sits *below* the screen switch and
 * above the content, so it reads as "these four screens, on this selection" —
 * and because the selection lives in the URL, switching screens keeps it.
 *
 * Mobile behaviour: the screen switch and the selector rows scroll
 * horizontally rather than wrapping or collapsing into a menu. The same code
 * ships to iOS and Android, and a hamburger that hides which subsystem is on
 * screen would be worse on a phone than a scroll.
 */

import {
  focusRing,
  layout,
  Pill,
  radius,
  space,
  usePalette,
  WattSteerMark,
} from "@wattsteer/ui";
import { router, usePathname } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { LanguageSwitch } from "@/components/language-switch";
import { VoiceTrigger } from "@/components/voice/voice-trigger";
import { type Copy, useCopy, useFormat, useI18n } from "@/i18n";
import { localePath } from "@/i18n/locale";
import {
  RUN_LABELS,
  type RunLabel,
  SUBSYSTEMS,
  type SubsystemCode,
  type Technology,
} from "@/lib/fixtures";
import { sharedParams, useAppParams } from "./use-app-params";
import { useServing } from "./use-serving";

/**
 * A screen is a key and a route. Its name is copy and lives in the
 * dictionaries — the route never is, which is why `path` is a literal here and
 * `label` is not: translating `/app/explain` would break navigation in one
 * locale only, and that is the kind of bug that hides until someone switches.
 */
interface ScreenDef {
  key: keyof Copy["app"]["shell"]["screens"];
  path: string;
}

const SCREENS: ScreenDef[] = [
  { key: "overview", path: "/app" },
  { key: "explain", path: "/app/explain" },
  { key: "mitigate", path: "/app/mitigate" },
  { key: "replay", path: "/app/replay" },
];

export function AppShell({
  children,
  showSelection = true,
}: {
  children: ReactNode;
  showSelection?: boolean;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const { locale } = useI18n();
  const pathname = usePathname();
  const params = useAppParams();

  const go = (path: string) => {
    router.push({
      pathname: path as never,
      params: sharedParams(params),
    });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.canvas }}
      contentContainerStyle={{ paddingBottom: 96 }}
    >
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          backgroundColor: colors.canvas,
        }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: layout.page,
            alignSelf: "center",
            paddingHorizontal: 20,
            paddingTop: 18,
            gap: space.lg,
          }}
        >
          {/*
            Wraps, since the badge stopped being one fixed-width pill.
            `NO MODEL PROMOTED` beside `PROTOTYPE` and the language switch does
            not fit a 400 px header, and measured in a browser at that width the
            unwrapped row clipped the second badge at the viewport edge — the
            page did not scroll sideways, so the only symptom was a truncated
            word. The brand keeps the left of the first line and the switch is
            pushed to the far edge of whatever line it lands on.
          */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 12,
            }}
          >
            <Pressable
              testID="app-home-link"
              accessibilityRole="link"
              accessibilityLabel={copy.app.shell.backToLanding}
              // This locale's landing page, not `/`. `/app` carries no locale
              // in its URL, so the one here comes from the stored choice the
              // language switch wrote; going via `/` would re-resolve it and
              // hand an English reader Portuguese whenever storage is blocked.
              // `dismissTo`, not `push`: pop back to the landing screen that
              // is already in the stack rather than mount a second copy of it.
              // See `localePath`.
              onPress={() => router.dismissTo(localePath(locale) as never)}
              style={(state) => {
                const { focused = false } = state as { focused?: boolean };
                return {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  borderRadius: radius.md,
                  padding: 4,
                  ...focusRing(focused, colors.focus),
                  ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                };
              }}
            >
              <WattSteerMark size={22} tint={colors.accent} />
              <Text style={{ fontSize: 15, fontWeight: "700", color: colors.ink }}>
                WattSteer
              </Text>
            </Pressable>
            <ChromeBadge />
            {/* Pushes the switch to the far edge of the header row. */}
            <View style={{ flex: 1 }} />
            <LanguageSwitch testID="app-language-switch" />
            {/*
              Right of `PT / EN`, exactly as `docs/plans/voice-copilot.md` §5.2
              sketches it, and deliberately **not** a fifth item in the tab row
              below: a route for voice would put it *beside* the four modes when
              its whole value is sitting *across* them, and it would break
              `sharedParams`, which is built on the four screens being four
              views of one selection. It renders nothing at all on a deployment
              with no key.
            */}
            <VoiceTrigger />
          </View>

          <ScrollView
            horizontal={true}
            showsHorizontalScrollIndicator={false}
            // Vertical padding inside the scroller, not margin outside it: the
            // pills carry a border and a focus ring, and a scroll viewport
            // clips at its own edge, so without it the top of each pill reads
            // as tucked under the header rule above.
            contentContainerStyle={{
              flexDirection: "row",
              gap: 8,
              paddingTop: 6,
              paddingBottom: 16,
            }}
          >
            {/* `role="tab"` requires a `tablist` ancestor, and the horizontal
                ScrollView is not one — axe's `aria-required-parent` failed on
                all four pills. The wrapper carries the role rather than the
                ScrollView because the scroller's own element is not the tabs'
                parent (react-native-web nests a content container inside it),
                and it repeats the row's `flexDirection`/`gap` so the rendered
                geometry is byte-for-byte what the content container produced
                on its own. */}
            <View
              accessibilityRole="tablist"
              accessibilityLabel={copy.app.shell.screensLabel}
              style={{ flexDirection: "row", gap: 8 }}
            >
              {SCREENS.map((screen) => (
                <Pill
                  key={screen.key}
                  accessibilityRole="tab"
                  label={copy.app.shell.screens[screen.key]}
                  tone="secondary"
                  active={
                    screen.path === "/app"
                      ? pathname === "/app" || pathname === "/app/"
                      : pathname.startsWith(screen.path)
                  }
                  onPress={() => go(screen.path)}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      </View>

      {showSelection ? <SelectionBar /> : null}

      <View
        style={{
          width: "100%",
          maxWidth: layout.page,
          alignSelf: "center",
          paddingHorizontal: 20,
          paddingTop: space.xl,
          gap: space.xl,
        }}
      >
        {children}
      </View>
    </ScrollView>
  );
}

/**
 * The chrome badge, and why it no longer says `FIXTURE DATA`.
 *
 * It said `PROTOTYPE · FIXTURE DATA` on every screen, unconditionally, and by
 * the time a reader asked why, it had been false on half of them for a while:
 * Mitigate solves on `POST /v1/optimize` and the Time Machine replays on `GET
 * /v1/replay`, and now the Overview and Explain read the gateway too. A label
 * that says every number on the page was invented, above four screens where
 * none of them is, is not a disclaimer — it is the one piece of copy on the
 * page that is definitely wrong, and it teaches a reader to ignore the ones
 * that are right.
 *
 * So it is two claims now, and each is rendered only while it is true.
 *
 *  - **`PROTOTYPE`** is unconditional, because it is still true. This is a
 *    prototype; the badge is not the place that stops being said.
 *  - **`NO MODEL PROMOTED`** is read from `/v1/meta` through
 *    {@link useServing}. Today it renders: the hot-swap gate refused the only
 *    artifact on both serving lanes and the retrain has not run, so every
 *    forecast read on every screen refuses. The day an artifact is promoted it
 *    disappears on its own, with no edit here — which is the test of whether it
 *    was a fact or a decoration.
 *
 * While `/v1/meta` is in flight, and when it could not be reached at all, only
 * the unconditional half renders. A chrome that guesses is a chrome that
 * flickers from a wrong claim to a right one, and "the gateway is down" is not
 * a statement about whether a model is promoted.
 */
function ChromeBadge() {
  const colors = usePalette();
  const copy = useCopy();
  const serving = useServing();
  const absent = serving.status === "known" && !serving.serving;
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
      }}
    >
      {/*
        **No `PROTÓTIPO` badge.** It was the chrome's standing caveat, and it
        earned its place while the screens drew fixture numbers. They do not:
        every figure here is either a settled ONS megawatt-hour or a model
        output that is withheld when there is no model, and the badge beside it
        says which. In that company "prototype" adds no fact — it is the context
        the reader already has, and a caveat that says nothing dilutes the one
        next to it that says a great deal.

        The copy key went with it. I had kept it, reasoning that a key costs
        nothing — and `i18n.test.ts`'s "no key is written and never rendered"
        refused that, correctly: an unrendered string is not free, it is copy two
        translators maintain and a reviewer has to decide about, for a screen
        that will never show it. If this chrome is ever needed somewhere the
        context is not implicit, the word is four characters to retype.
      */}
      {/*
        **Always occupies its width; only sometimes says anything.**

        The rule above — withhold the claim until `/v1/meta` has answered — is
        right and is kept. What was wrong was withholding the *space*. This
        badge sits in a `flexWrap` row, so appearing at ~4s did not merely add a
        pill: it pushed `PT / EN` and the voice trigger onto a second line and
        moved every pixel of the screen below down by 42. Measured on
        production at 412px, that one reflow was the whole of `/app`'s
        cumulative layout shift — **0.215**, against Lighthouse's 0.1 threshold
        — and it landed four seconds in, which is exactly when a reader has
        started reading.

        So the pill is always rendered and always measured; `opacity` is what
        the meta read controls. A transparent box makes no claim, which is what
        the rule actually asks for, and `aria-hidden` keeps it out of the
        accessibility tree so a screen reader is told no more than an eye is.

        The `testID` stays conditional on the fact rather than on the box: the
        reserved copy is not the badge, and nothing should be able to assert it
        is. `test/wired-screens.test.ts` holds the `absent` expression itself.

        The cost is one wrapped header line on a narrow viewport in the state
        where a model *is* promoted. That is the right way round: reserving
        space that is sometimes blank is a fixed, invisible cost, where
        collapsing it is a visible jump under the reader's eye. Stability is
        the thing being bought.
      */}
      <View
        testID={absent ? "app-no-model-badge" : undefined}
        aria-hidden={absent ? undefined : true}
        style={{
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: colors.warning,
          backgroundColor: colors.warningSoft,
          paddingHorizontal: 10,
          paddingVertical: 4,
          opacity: absent ? 1 : 0,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "600", color: colors.onWarningSoft }}>
          {copy.app.shell.noModelBadge}
        </Text>
      </View>
    </View>
  );
}

/** Subsystem, technology and run — the selection every screen reads. */
export function SelectionBar() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.canvasTint,
      }}
    >
      {/*
        The tint band spans the viewport, but its contents sit in the same
        max-width column as the header and the screen body. Without this the
        selector starts hard against the left edge while everything above and
        below it is centred, which is what breaks the page's rhythm on a wide
        display. The inner view is still full width on a narrow one, so the
        horizontal scroll behaviour on mobile is unchanged.
      */}
      <View
        style={{
          width: "100%",
          maxWidth: layout.page,
          alignSelf: "center",
        }}
      >
        <ScrollView
          horizontal={true}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xl,
            paddingHorizontal: 20,
            paddingVertical: 12,
          }}
        >
          <Group label={copy.app.shell.selection.subsystem}>
            {SUBSYSTEMS.map((s) => (
              <MiniPill
                key={s.code}
                label={s.short}
                active={params.subsystem === s.code}
                onPress={() => params.setParams({ subsystem: s.code as SubsystemCode })}
              />
            ))}
          </Group>
          <Group label={copy.app.shell.selection.technology}>
            {(["WIND", "SOLAR"] as Technology[]).map((tech) => (
              <MiniPill
                key={tech}
                label={copy.app.technology[tech]}
                active={params.technology === tech}
                onPress={() => params.setParams({ technology: tech })}
              />
            ))}
          </Group>
          <Group label={copy.app.shell.selection.run}>
            {RUN_LABELS.map((run) => (
              <MiniPill
                key={run}
                label={run}
                active={params.run === run}
                onPress={() => params.setParams({ run: run as RunLabel })}
              />
            ))}
          </Group>
          <View>
            <Text style={{ fontSize: 10, color: colors.inkFaint, marginBottom: 4 }}>
              {copy.app.shell.selection.targetDay}
            </Text>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.ink }}>
              {f.date(params.date)}
            </Text>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const colors = usePalette();
  return (
    <View>
      <Text style={{ fontSize: 10, color: colors.inkFaint, marginBottom: 4 }}>
        {label}
      </Text>
      <View style={{ flexDirection: "row", gap: 6 }}>{children}</View>
    </View>
  );
}

export function MiniPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const colors = usePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      aria-checked={active}
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={(state) => {
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: active
            ? colors.accentSoft
            : hovered
              ? colors.surfaceSunken
              : "transparent",
          paddingHorizontal: 12,
          paddingVertical: 5,
          ...focusRing(focused, colors.focus, 1),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        };
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: active ? "700" : "500",
          color: active ? colors.onAccentSoft : colors.inkMuted,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Page title block, used at the top of each screen's content. */
export function ScreenTitle({
  title,
  lede,
  right,
}: {
  title: string;
  lede: string;
  right?: ReactNode;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: space.lg,
      }}
    >
      {/*
        `flexShrink: 1` beside the grow, because react-native-web defaults
        `flexShrink` to **0** where CSS defaults it to 1. Without it this column
        sits at its `flexBasis` or wider and never gives width back, so at 400px
        the lede ran to 609px inside a 360px box and the remainder was clipped —
        the same defect `PanelHeader` carried, from the same default.
      */}
      <View style={{ gap: 6, flexGrow: 1, flexShrink: 1, flexBasis: 320 }}>
        <Text
          style={{
            fontSize: 28,
            lineHeight: 34,
            fontWeight: "600",
            letterSpacing: -0.5,
            color: colors.ink,
          }}
        >
          {title}
        </Text>
        <Text style={{ fontSize: 14, lineHeight: 22, color: colors.inkMuted }}>
          {lede}
        </Text>
      </View>
      {right}
    </View>
  );
}
