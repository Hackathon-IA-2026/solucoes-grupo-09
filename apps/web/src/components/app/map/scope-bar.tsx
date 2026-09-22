/**
 * The scope control that sits over the globe.
 *
 * ## What "SIN Geral" can honestly mean
 *
 * The obvious reading — one national figure — is the one thing this control must
 * not do. A national band would be four bands added together, and quantiles do
 * not add: `test/no-summed-bands.test.ts` forbids it across this whole tree, and
 * the gateway does not serve one either. The only national total the product has
 * is `GridNow.national`, which is *settled* megawatt-hours and carries
 * `derived: "sum_of_four"` on the object to say so.
 *
 * So scope switches the **subject**, not the arithmetic:
 *
 *  - **SIN Geral** — no region is chosen, and every question is answered about
 *    the subsystem that leads the day. That is a real answer to "where?" rather
 *    than an average of four places, and it is the number an operator acts on.
 *  - **Por Região** — the reader has chosen, and the same questions are answered
 *    about their choice.
 *
 * Both are one subsystem's figures with the subject named. Neither invents a
 * fifth.
 */

import { radius, space, type, usePalette } from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { useCopy, useFormat } from "@/i18n";
import {
  RUN_LABELS,
  type RunLabel,
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";

export type Scope = "sin" | "region";

function Chip({
  label,
  active,
  disabled = false,
  hint,
  onPress,
}: {
  label: string;
  active: boolean;
  /** A gate with no lane that can serve. Shown, and not pressable. */
  disabled?: boolean;
  hint?: string;
  onPress: () => void;
}) {
  const colors = usePalette();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      /*
        The label stays the label and the reason is a *hint*. Passing the
        refusal sentence as `accessibilityLabel` replaced the name, so a screen
        reader on an inert `12Z` heard why it could not be used and never which
        run it was. `aria-disabled` rather than only `disabled` for the same
        reason the shell's pills carry it: a control removed from the tab order
        with no announced state is a control that silently is not there.
      */
      accessibilityLabel={label}
      accessibilityHint={disabled ? hint : undefined}
      aria-disabled={disabled || undefined}
      aria-pressed={active}
      style={{
        opacity: disabled ? 0.38 : 1,
        paddingVertical: 5,
        paddingHorizontal: space.sm,
        borderRadius: radius.pill,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: active ? colors.accent : "transparent",
        backgroundColor: active ? colors.accentSoft : "transparent",
        ...(Platform.OS === "web"
          ? ({ cursor: disabled ? "not-allowed" : "pointer" } as object)
          : null),
      }}
    >
      <Text
        style={{
          ...type.caption,
          color: active ? colors.accent : colors.inkMuted,
          fontWeight: active ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ScopeBar({
  scope,
  subsystem,
  run,
  runInert,
  date,
  latestDate,
  onDate,
  onScope,
  onSubsystem,
  onRun,
}: {
  scope: Scope;
  subsystem: SubsystemCode;
  /**
   * The D−1 weather run, which used to live in the chrome's selection bar.
   *
   * It is here because this screen no longer renders that bar: every control it
   * held now sits beside the thing it changes, and the run changes the whole
   * scene. Keeping a bar of three controls above a screen that already shows
   * all three is how a page acquires two places to do the same thing.
   */
  run?: RunLabel;
  runInert?: (run: RunLabel) => boolean;
  /**
   * The civil day the whole screen is about, and the two controls that move it.
   *
   * Here for the reason the run chips are: it changes the entire scene, and
   * every control that does now sits beside the scene rather than in a bar
   * above it. Optional, so the screens that have no day axis do not have to
   * decline one.
   */
  date?: string;
  /** The newest day there is anything to show for. `onDate` is inert past it. */
  latestDate?: string;
  onDate?: (date: string) => void;
  onScope: (scope: Scope) => void;
  /** Choosing a region also chooses the scope; the parent does both. */
  onSubsystem: (code: SubsystemCode) => void;
  onRun?: (run: RunLabel) => void;
}) {
  const f = useFormat();
  const colors = usePalette();
  const copy = useCopy();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        // `flexWrap` alone does not wrap anything here: react-native-web
        // defaults `flexShrink` to 0, so the row keeps its content width and
        // pushes past a 320 px viewport instead of breaking. (ADR-0001.)
        flexShrink: 1,
        minWidth: 0,
        gap: space.sm,
        paddingVertical: 6,
        paddingHorizontal: space.sm,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: "rgba(12,13,18,0.78)",
        ...(Platform.OS === "web" ? ({ backdropFilter: "blur(10px)" } as object) : null),
      }}
    >
      <Text style={{ ...type.caption, color: colors.inkFaint, paddingLeft: 4 }}>
        {copy.app.grid.scopeLabel}
      </Text>
      <Chip
        label={copy.app.grid.scopeSin}
        active={scope === "sin"}
        onPress={() => onScope("sin")}
      />
      <Chip
        label={copy.app.grid.scopeRegion}
        active={scope === "region"}
        onPress={() => onScope("region")}
      />

      <View
        style={{
          width: 1,
          height: 18,
          marginHorizontal: 2,
          backgroundColor: colors.border,
        }}
      />

      {/*
        **The day, with two arrows and no calendar.**

        Arrows rather than a picker because the thing a reader wants is almost
        always the day before or the day after — a grid operator comparing a
        morning against yesterday's — and a calendar for that is a dependency
        and a popover for a job two buttons do. `docs/lint-policy.md`'s rule on
        dependencies is the same rule: prefer the platform.

        Forward is inert at `latestDate`, which is the day being forecast:
        there is no day after tomorrow to show, and an arrow that leads to four
        stated absences is an arrow that teaches a reader the control is
        broken. Backwards has no floor — the panels state what a day does not
        have, and `GET /v1/grid/day` answers a quiet day with zeros rather than
        a refusal, so walking into the past degrades into honest emptiness
        instead of an error.
      */}
      {date === undefined || onDate === undefined ? null : (
        <>
          <Chip
            label="‹"
            active={false}
            hint={copy.app.grid.dayPreviousHint}
            onPress={() => onDate(addDays(date, -1))}
          />
          <Text
            testID="scope-bar-date"
            style={{ ...type.caption, color: colors.ink, fontVariant: ["tabular-nums"] }}
          >
            {f.date(date)}
          </Text>
          <Chip
            label="›"
            active={false}
            disabled={latestDate !== undefined && date >= latestDate}
            hint={copy.app.grid.dayNextHint}
            onPress={() => onDate(addDays(date, 1))}
          />
          <View
            style={{
              width: 1,
              height: 18,
              marginHorizontal: 2,
              backgroundColor: colors.border,
            }}
          />
        </>
      )}

      {/*
        The region chips stay pressable in either scope, because pressing one is
        the natural way to *enter* the regional scope — making them inert until
        the reader had already switched would be a control that asks to be
        unlocked before it can be used.
      */}
      {/*
        **Marked only in the regional scope, because "todos" means no one of
        them.**

        `SIN Geral` lit beside a lit `NE` is the control contradicting itself:
        one says the figures are about all four, the other says they are about
        the Northeast. So the region marks stand down whenever the scope is the
        overall one.

        The deep link that this used to break — `/app?subsystem=S`, somebody
        pointing at Sul — is handled where it belongs instead: the screen opens
        in the regional scope when the URL named a region. See
        `subsystemFromUrl` in `params.ts`.
      */}
      {SUBSYSTEM_DISPLAY_ORDER.map((code) => (
        <Chip
          key={code}
          label={subsystemMeta(code).short}
          active={scope === "region" && code === subsystem}
          onPress={() => onSubsystem(code)}
        />
      ))}

      {/*
        The run chips appear only where the screen has no selection bar carrying
        them — the console. On the Overview the same control is already in the
        chrome, and two of one control on one page is how a reader learns that
        one of them is decoration.
      */}
      {run === undefined || runInert === undefined || onRun === undefined ? null : (
        <>
          <View
            style={{
              width: 1,
              height: 18,
              marginHorizontal: 2,
              backgroundColor: colors.border,
            }}
          />
          <Text style={{ ...type.caption, color: colors.inkFaint }}>
            {copy.app.grid.runLabel}
          </Text>
          {RUN_LABELS.map((label) => (
            <Chip
              key={label}
              label={label}
              active={label === run}
              disabled={runInert(label as RunLabel)}
              hint={
                runInert(label as RunLabel)
                  ? copy.app.shell.selection.runUnavailable
                  : undefined
              }
              onPress={() => onRun(label as RunLabel)}
            />
          ))}
        </>
      )}
    </View>
  );
}

/**
 * A civil date shifted by whole days, as a `YYYY-MM-DD` string.
 *
 * Built at UTC midnight and read back as an ISO date, which is exact for whole
 * days in any zone: the arithmetic never touches an hour, so a Brasília
 * transition cannot move the answer. It is the same shape `daysFrom` uses in
 * `use-network.ts`, and it stays here rather than being shared because two
 * call sites is not a module.
 */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
