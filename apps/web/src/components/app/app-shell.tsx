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
  type as typeTokens,
  usePalette,
  WattSteerMark,
} from "@wattsteer/ui";
import { router, usePathname } from "expo-router";
import { type ReactNode, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { LanguageSwitch } from "@/components/language-switch";
import { type Copy, useCopy, useFormat, useI18n } from "@/i18n";
import { localePath } from "@/i18n/locale";
import {
  RUN_LABELS,
  type RunLabel,
  SUBSYSTEMS,
  type SubsystemCode,
} from "@/lib/fixtures";
import { gateProfileOf, sharedParams, useAppParams } from "./use-app-params";
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

/*
  Two, and it used to be four.

  Explicar and Mitigar are not places; they are two more things to say about the
  selection Visão da rede is already showing, and putting them behind tabs made
  "why is the NE at risk?" a navigation away from the map that raised the
  question. They are sections of `/app` now. Máquina do tempo stays, because it
  is a different mode — another day, another axis, another question — and not
  another view of this selection.

  Their routes still exist and still render standalone, for a link somebody
  already has and for the voice agent's `explain` tool.

  **Two, and the middle pair went through anchors on the way out.** Dropping
  them from the row the first time was wrong for a measured reason: `/app` at
  360px with a forecast was 13 472px tall, `#mitigate` started at 8532px, and
  nothing above the fold said either existed. So they came back as anchors.

  They are gone again now, and this time the page answers the same objection
  without them: `SectionBlock` is a collapsed accordion, so both headings sit a
  few hundred pixels under the map with a control that says there is more
  behind it. The cue is on the screen instead of in the chrome, which is where
  it belonged — the row is for places a reader goes, and these are two more
  things to say about the selection they are already looking at.
*/
const SCREENS: ScreenDef[] = [
  { key: "overview", path: "/app" },
  { key: "replay", path: "/app/replay" },
];

/**
 * Scroll to a section, waiting for it to exist.
 *
 * A jump that follows a navigation cannot assume the target is laid out yet —
 * the page it belongs to may not have rendered. Polling a few frames is the
 * honest version of a `setTimeout` guess, and it gives up rather than
 * scrolling to whatever has appeared by the time it runs out.
 */
export function scrollToSection(id: string, attempt = 0): void {
  if (Platform.OS !== "web" || typeof document === "undefined") {
    return;
  }
  const node = document.getElementById(id);
  if (node !== null) {
    node.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (attempt < 40) {
    requestAnimationFrame(() => scrollToSection(id, attempt + 1));
  }
}

export function AppShell({
  children,
  showSelection = true,
  bleed = false,
}: {
  children: ReactNode;
  showSelection?: boolean;
  /**
   * Let the body out of the centred column and off the padding.
   *
   * Every screen so far is a document: a measured column with gutters, which is
   * what makes a page of figures readable. A map is not a document — it wants
   * the window, and a 1280px column with 20px of gutter on a 2560px display is
   * a map in a letterbox.
   *
   * A flag rather than a second shell, because the chrome above is the same
   * chrome and must stay so: the nav, the selection bar and the language switch
   * are how a reader gets *out*, and a full-bleed screen that reinvented them
   * would be a screen you can get lost on.
   */
  bleed?: boolean;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const { locale } = useI18n();
  const pathname = usePathname();
  const params = useAppParams();

  const go = (path: string) => {
    const [route, anchor] = path.split("#");
    if (anchor !== undefined && (pathname === route || pathname === `${route}/`)) {
      // Already on the page that holds it. Nothing to navigate.
      scrollToSection(anchor);
      return;
    }
    router.push({
      pathname: (route ?? path) as never,
      params: sharedParams(params),
    });
    if (anchor !== undefined) {
      scrollToSection(anchor);
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      /*
        A document scrolls and reserves room under its last line. A screen that
        owns the viewport does neither — and `flexGrow` is what makes that true
        rather than merely intended: without it the content container is only as
        tall as its content, `flex: 1` inside it resolves against nothing, and
        the map grows until the timeline below it is off the fold.
      */
      style={{
        backgroundColor: colors.canvas,
        /*
          `flex: 1` is not enough and the reason is worth writing down: it
          resolves against the parent, and nothing above this is height-bounded
          — the router's stack lets the document grow. So on web the viewport is
          named directly. `100dvh` rather than `100vh` because mobile browsers
          shrink the visual viewport as their chrome retracts, and `vh` keeps
          the taller number: the timeline would sit under the address bar on the
          one device where it is hardest to scroll to.
        */
        ...(bleed && Platform.OS === "web" ? ({ height: "100dvh" } as object) : null),
        ...(bleed ? { flex: 1 } : null),
      }}
      contentContainerStyle={
        bleed
          ? /*
              `flexShrink` and `minHeight` beside the grow, and both were
              missing from the first attempt. A content container defaults to
              `flex: 1 0 auto` — it grows to its content and never shrinks — so
              it sized to chrome plus an unbounded map and overflowed the
              viewport it was told to fit in. Measured: 1 181px inside a 1 000px
              scroller, which is exactly where the timeline went.
            */
            { flexGrow: 1, flexShrink: 1, minHeight: 0 }
          : { paddingBottom: 96 }
      }
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
            {/*
              **The voice control is not here any more, and this is the row it
              kept breaking.**

              `Falar` sat between the badge and `PT / EN`. On a phone the three
              did not fit: the badge below reserves its width unconditionally
              (deliberately — see the note on it), so with a model promoted the
              trigger and the language switch wrapped onto a second line and the
              header grew a row that said nothing new.

              Nothing is lost by dropping it. The dock in the bottom-right
              corner says "Pergunte ao WattSteer", is the same `agent.open`, and
              is in a corner that is not competing with anything for width. Two
              entry points to one session were one more than the feature needed,
              and the one that survived is the one that reads as the product
              rather than as chrome.
            */}
            <LanguageSwitch testID="app-language-switch" />
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
            {/*
              **Links, not tabs, and the `tablist` around them is gone.**

              A tab promises a panel in the same document that it controls. Two
              of these four are jumps to sections on this page and two are
              navigations to other documents, and none of them controls a
              tabpanel — there was no `aria-controls` on any of them and never
              could be. The role was here only because `role="tab"` demands a
              `tablist` parent and axe's `aria-required-parent` said so; once
              the wrong role goes the wrapper it required goes with it.

              The unification made it plainly wrong rather than merely loose:
              the two things on this page that *are* regions are marked
              `role="region"`, while the two things that are not on this page
              were the ones calling themselves tabs. On `/app/explain` neither
              pill reported `aria-selected`, so a reader landed on a page whose
              nav claimed neither destination.

              `aria-current="page"` carries what `aria-selected` was being asked
              to carry, and carries it correctly: it marks the document the
              reader is on, and an anchor into the current page is not one.
            */}
            <View style={{ flexDirection: "row", gap: 8 }}>
              {SCREENS.map((screen) => {
                const current =
                  screen.path === "/app"
                    ? pathname === "/app" || pathname === "/app/"
                    : !screen.path.includes("#") && pathname.startsWith(screen.path);
                return (
                  <Pill
                    key={screen.key}
                    accessibilityRole="link"
                    ariaCurrent={current ? "page" : undefined}
                    label={copy.app.shell.screens[screen.key]}
                    tone="secondary"
                    active={current}
                    onPress={() => go(screen.path)}
                  />
                );
              })}
            </View>
          </ScrollView>
        </View>
      </View>

      {showSelection ? <SelectionBar /> : null}

      {/*
        **The page's main landmark, which it did not have.**

        A rendered landmark dump of `/app` found exactly two: the `region` on
        Explicar and the `region` on Mitigar. The Overview — the page's primary
        content, and 70–88% of its height — had none, so landmark navigation
        offered a reader the two smallest parts of the page and not the largest.
        `role="main"` here makes the two sections nest inside it, which is the
        structure the unification actually created.

        Web-only, via the same escape hatch `SectionBlock` uses: react-native's
        `AccessibilityRole` union is the intersection of three platforms and has
        no `main`.
      */}
      <View
        {...(Platform.OS === "web" ? ({ role: "main" } as object) : null)}
        style={
          bleed
            ? { width: "100%", flex: 1 }
            : {
                width: "100%",
                maxWidth: layout.page,
                alignSelf: "center",
                paddingHorizontal: 20,
                paddingTop: space.xl,
                gap: space.xl,
              }
        }
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
  const serving = useServing();
  /*
    Only once `/v1/meta` has answered. While it is in flight the pills stay
    live, for the same reason the chrome badge stays blank: guessing produces a
    control that dims and then brightens, which is worse than one that was
    briefly honest about nothing.
  */
  /*
    **Per lane, and it used to be per deployment.**

    This asked `!serving.serving` — is *any* lane promoted? — and dimmed both
    pills together. That was right while nothing was promoted anywhere and
    became wrong the moment one lane was: `gate_early` promoted, `gate_late`
    refused by its serving smoke because an upstream ONS feed went quiet, and
    both pills went live. Pressing `12Z` then drew exactly the same screen as
    `00Z`, with nothing saying why, which is how a reader learns that a control
    is decoration.

    Each label names one gate — `00Z` is `gate_early`, `12Z` is `gate_late`,
    from the published gate table — so each pill can ask about its own lane.
    `usable` is tri-state and `undefined` means the modelling service is too old
    to report it: read as unknown and never rounded down to a refusal, which is
    the same rule `absence.ts` states where the field is defined.

    Note what this deliberately does *not* dim: a lane that is promoted but has
    published nothing for the day in question. That pill is live — tomorrow
    morning's gate will fill it — and the absence of today's forecast is stated
    by `ForecastAbsent` on the screen, where the reason belongs.
  */
  const laneFor = (run: RunLabel) => {
    if (serving.status !== "known") {
      return;
    }
    const profile = gateProfileOf(run);
    return serving.lanes.find((lane) => lane.name.includes(profile));
  };
  const runInertFor = (run: RunLabel) => {
    const lane = laneFor(run);
    return lane !== undefined && (lane.condition !== "promoted" || lane.usable === false);
  };
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
          {/*
            **Technology used to be a third group here, and it was feedback with
            no visible effect.**

            It was never inert — it flips which fleet the "Eólica e solar" panel
            emphasises, bold and 0.85 opacity against 0.28. The problem was
            distance: measured at 400px, the pills sat at y=197 and the panel
            they re-weight at **y=2719**, which is nearly three phone screens
            below. A reader pressed `Solar`, the page did exactly what it was
            asked, and nothing they could see changed. A control whose whole
            feedback is off-screen teaches a reader that the app ignores them.

            Nor was it a filter, which is the other half of why it does not
            belong in the chrome: both fleets are always drawn, in every panel
            that draws either. It re-weights; it never selects.

            `params.technology` stays. The voice agent sets it — "destaque a
            solar" — and `context.ts` reports it, and there the distance problem
            does not exist because the agent scrolls to what it is talking
            about. What is gone is the claim that this is one of the two axes a
            reader steers the whole product by.
          */}
          {/*
            The run is the only selector here that can go inert.

            `subsystem` and `technology` steer the observed panels as well as
            the forecast ones, so they always move something. The run chooses
            which D−1 forecast to read, and it is read in exactly two places —
            the Overview's and Explain's forecast half. With no lane promoted
            both refuse whatever it is set to, so every choice draws the same
            screen, on all four tabs.

            `useServing` is the right question to ask and it is already asked
            once before first paint for the chrome badge. It is also the stable
            one: a forecast can refuse for the hour as well (the gate not having
            passed yet), and gating on that would have these pills flicker
            through the day. "No model is promoted" holds for weeks at a time,
            which is what a reader can actually act on.
          */}
          <Group label={copy.app.shell.selection.run}>
            {RUN_LABELS.map((run) => (
              <MiniPill
                key={run}
                label={run}
                active={params.run === run}
                disabled={runInertFor(run as RunLabel)}
                disabledHint={copy.app.shell.selection.runUnavailable}
                onPress={() => params.setParams({ run: run as RunLabel })}
              />
            ))}
          </Group>
          <View>
            {/* 11px, the size every other caption on these screens uses. At
                10px these four were the smallest text in the product and the
                only 10px on the page, for the labels of its primary controls —
                a deviation that bought nothing. */}
            <Text style={{ fontSize: 11, color: colors.inkFaint, marginBottom: 4 }}>
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
      <Text style={{ fontSize: 11, color: colors.inkFaint, marginBottom: 4 }}>
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
  disabled = false,
  disabledHint,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  /**
   * The control cannot change what the screen shows.
   *
   * Not a styling flag: it is the same statement every panel on these screens
   * already makes when it withholds itself, made by a control instead. A pill
   * that stays bright and pressable while moving nothing is the one dishonesty
   * this product cannot afford, because the reader has no way to tell it apart
   * from one that works.
   */
  disabled?: boolean;
  /** Why, in the reader's locale. Announced, and shown on hover. */
  disabledHint?: string;
}) {
  const colors = usePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      aria-checked={active}
      accessibilityLabel={label}
      // The hint rides on the label rather than replacing it: a screen reader
      // should still hear which run this pill is, then why it cannot be taken.
      accessibilityHint={disabled ? disabledHint : undefined}
      aria-disabled={disabled || undefined}
      disabled={disabled}
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
          borderColor: active && !disabled ? colors.accent : colors.border,
          backgroundColor:
            active && !disabled
              ? colors.accentSoft
              : hovered && !disabled
                ? colors.surfaceSunken
                : "transparent",
          paddingHorizontal: 12,
          paddingVertical: 5,
          // Dimmed rather than hidden. The run still *has* a value, and it is
          // still carried across screens by `sharedParams`; what has gone is
          // the ability to change what is drawn. Removing the group would hide
          // a selection the reader still owns.
          opacity: disabled ? 0.45 : 1,
          ...focusRing(focused, colors.focus, 1),
          ...(Platform.OS === "web"
            ? ({ cursor: disabled ? "not-allowed" : "pointer" } as object)
            : null),
        };
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: active && !disabled ? "700" : "500",
          color: active && !disabled ? colors.onAccentSoft : colors.inkMuted,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Page title block, used at the top of each screen's content. */
/**
 * A page's or a section's top line.
 *
 * `level` does two jobs that have to agree, and until the unification neither
 * was being done. It picks the size — `type.h2` for the page, `type.h3` for a
 * section — and it sets `aria-level`, so the outline a screen reader walks is
 * the one an eye sees.
 *
 * Both mattered more the moment three routes became one page. A rendered dump
 * of `/app` returned **no headings at all** — `querySelectorAll("h1,…,h6,
 * [role=heading]")` was empty across 13 472px — and the three titles that had
 * been three page titles were now one page title and two section titles, all
 * still at 28px. Three peers at the same size claim a document with three tops;
 * with no heading semantics, size was the only hierarchy signal there was, and
 * it was saying the wrong thing.
 *
 * `packages/ui/src/components/legal.tsx` already had the idiom — react-native
 * has no `<h2>`, and `accessibilityRole="header"` plus `aria-level` is how the
 * web pass emits one.
 */
export function ScreenTitle({
  title,
  lede,
  right,
  level = 1,
}: {
  title: string;
  lede: string;
  right?: ReactNode;
  /** 1 for the page's own title, 2 for a section under it. */
  level?: 1 | 2;
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
          accessibilityRole="header"
          aria-level={level}
          style={{
            ...(level === 1 ? typeTokens.h2 : typeTokens.h3),
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

/**
 * One concern of the page, under its own heading.
 *
 * Visão da rede, Explicar and Mitigar are three questions about **one**
 * selection — the same subsystem, the same day, the same run — and they were
 * three routes. Clicking a region on the map to ask "why?" meant a navigation,
 * a fresh read and a page that rebuilt itself around the answer to a question
 * the reader had already framed. Máquina do tempo is genuinely a different
 * mode and keeps its own route; these three do not.
 *
 * `nativeID` gives each section an anchor, so `/app#explain` still lands where
 * `/app/explain` used to and the voice agent's `explain` tool has somewhere to
 * send a reader without leaving the page.
 */
export function SectionBlock({
  id,
  title,
  lede,
  right,
  children,
}: {
  id: string;
  title: string;
  lede: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const colors = usePalette();
  const copy = useCopy();
  /*
    **Collapsed by default, and that is the discoverability fix.**

    These two sections used to be routes, then anchors in the nav row, and the
    nav row is two destinations again — Visão da rede and Máquina do tempo,
    which are the only two places a reader actually goes. That left the problem
    the review named: two of the product's three questions eight thousand
    pixels down a page with nothing above the fold saying they exist.

    A collapsed accordion answers it better than an anchor did. The heading is
    *on the screen*, a few hundred pixels under the map, with a control that
    says there is more behind it — which is precisely the "visible cue" whose
    absence made this a blocker. And the page is short again: a reader who
    wants the map gets the map, and a reader who wants the diagnosis opens it.

    `aria-expanded` and a rotating chevron, not colour: a state change that is
    only an animation is a state change a stopped animation loses.
  */
  const [open, setOpen] = useState(false);
  return (
    <View
      nativeID={id}
      /*
        A landmark, so a screen reader can jump between the sections the way the
        routes used to let a reader jump between pages. `region` is not in
        react-native's `AccessibilityRole` union — that enum is the intersection
        of what iOS, Android and the web can express — so it goes on as a web
        prop, the same escape hatch this file uses for `cursor: "pointer"`.
      */
      {...(Platform.OS === "web"
        ? ({ role: "region", "aria-label": title } as object)
        : { accessibilityLabel: title })}
      style={{
        gap: open ? space.lg : space.md,
        paddingTop: space.xl,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onPress={() => setOpen((value) => !value)}
        style={(state) => {
          const { focused = false } = state as { focused?: boolean };
          return {
            borderRadius: radius.md,
            ...focusRing(focused, colors.focus),
            ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
          };
        }}
      >
        <ScreenTitle
          title={title}
          lede={lede}
          level={2}
          right={
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              {open ? right : null}
              <Text style={{ ...typeTokens.label, color: colors.inkMuted }}>
                {open ? copy.app.shell.collapse : copy.app.shell.expand}
              </Text>
              {/* A caret, drawn rather than imported: one glyph, two rotations,
                  and it is the static cue that survives reduced motion. */}
              <Text
                style={{
                  fontSize: 13,
                  lineHeight: 18,
                  color: colors.inkMuted,
                  transform: [{ rotate: open ? "180deg" : "0deg" }],
                }}
              >
                {"\u25BE"}
              </Text>
            </View>
          }
        />
      </Pressable>
      {open ? (
        <View nativeID={`${id}-body`} style={{ gap: space.xl }}>
          {children}
        </View>
      ) : null}
    </View>
  );
}
