import {
  type ReviewSort,
  type ScrapeRequest,
  type ScrapeState,
  validateInput,
} from "@zalytix/core";
import {
  ArrowRightIcon,
  focusRing,
  gradientBg,
  LinkIcon,
  layout,
  motion,
  radius,
  SparklesIcon,
  space,
  useContainerWidth,
  usePalette,
  ZapIcon,
} from "@zalytix/ui";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useAppPreview } from "@/hooks/use-app-preview";
import { AppPreviewCard } from "./app-preview-card";
import { HeroWidgets } from "./hero-widgets";
import { StoreChip } from "./store-chip";

const SAMPLES = [
  { label: "App Store", url: "https://apps.apple.com/us/app/instagram/id389801252" },
  {
    label: "Google Play",
    url: "https://play.google.com/store/apps/details?id=com.spotify.music",
  },
];

const LIMITS = [50, 100, 200, 500];
const SORTS: ReadonlyArray<{ value: ReviewSort; label: string }> = [
  { value: "mostRecent", label: "Newest" },
  { value: "mostHelpful", label: "Most helpful" },
];
const COUNTRIES = [
  "us",
  "gb",
  "de",
  "fr",
  "es",
  "it",
  "br",
  "mx",
  "in",
  "jp",
  "au",
  "ca",
];

/** Errors only surface once typing settles — never mid-keystroke. */
const ERROR_SETTLE_MS = 800;

/** Static shells for the larger style objects (dynamic bits merge at render). */
const styles = StyleSheet.create({
  kicker: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: space.xl,
  },
  capsule: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 8,
  },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 5,
    minHeight: 28,
    justifyContent: "center",
  },
  errorBanner: {
    marginTop: space.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: space.md,
  },
});

/** Live status line per machine phase (the reference's step ticker, for real). */
function phaseLabel(state: ScrapeState): string {
  switch (state.phase) {
    case "submitting":
      return "Submitting scrape…";
    case "queued":
      return "Queued — waiting for a scraper slot…";
    case "scraping":
      return state.progress
        ? `Scraping ${state.progress.collected}${state.progress.limit ? ` of ${state.progress.limit}` : ""} reviews…`
        : "Browsing the store like a human…";
    default:
      return "";
  }
}

function phasePercent(state: ScrapeState): number {
  if (state.phase === "submitting") {
    return 6;
  }
  if (state.phase === "queued") {
    return 12;
  }
  if (state.phase === "scraping") {
    if (state.progress?.limit) {
      return Math.min(96, 15 + (state.progress.collected / state.progress.limit) * 80);
    }
    return 30;
  }
  return 0;
}

function Glow({ color, size, style }: { color: string; size: number; style: object }) {
  return (
    <View
      aria-hidden={true}
      style={{
        pointerEvents: "none",
        position: "absolute",
        width: size,
        height: size,
        borderRadius: size / 2,
        opacity: 0.3,
        ...gradientBg(
          `radial-gradient(closest-side, ${color}, transparent)`,
          "transparent",
        ),
        ...(Platform.OS === "web" ? ({ filter: "blur(80px)" } as object) : null),
        ...style,
      }}
    />
  );
}

function FeatureDot({ label }: { label: string }) {
  const colors = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }}
      />
      <Text style={{ fontSize: 12, color: colors.inkMuted }}>{label}</Text>
    </View>
  );
}

/** Brand block: bolt mark over the glow, kicker pill, and the headline. */
function HeroBrand({ wideHeadline }: { wideHeadline: boolean }) {
  const colors = usePalette();
  return (
    <>
      <Image
        testID="hero-logo"
        source={require("../../assets/images/bolt-logo.png")}
        style={{ width: 76, height: 82, marginBottom: space.xl }}
        contentFit="contain"
        accessibilityLabel="Zalytix"
        transition={200}
      />
      {/* Kicker */}
      <View
        style={[
          styles.kicker,
          { borderColor: colors.border, backgroundColor: colors.surface },
        ]}
      >
        <SparklesIcon size={14} color={colors.accent} />
        <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
          Review intelligence, in seconds
        </Text>
      </View>

      <Text
        accessibilityRole="header"
        aria-level={1}
        // data-hero-headline: the static render can't know the viewport, so
        // a media query in +html.tsx forces the wide variant (44px, one line)
        // from first paint on ≥960px screens — otherwise the post-hydration
        // flip from the narrow variant registers as layout shift (CLS).
        {...({ dataSet: { "hero-headline": "true" } } as object)}
        style={{
          textAlign: "center",
          color: colors.ink,
          fontSize: wideHeadline ? 44 : 34,
          lineHeight: wideHeadline ? 50 : 40,
          fontWeight: "600",
          letterSpacing: -1.2,
          // Wide: one line (the hero column is widened past the 672px
          // content column just for the headline). Narrow: a controlled
          // break so "clean data." owns the second line.
          maxWidth: wideHeadline ? 1000 : 640,
        }}
      >
        Turn any app's reviews{wideHeadline ? " " : "\n"}into{" "}
        <Text style={{ color: colors.accent }}>clean data.</Text>
      </Text>
    </>
  );
}

/** While a job runs: spinner, real progress bar, phase label, cancel. */
function ScrapeProgress({
  state,
  onCancel,
}: {
  state: ScrapeState;
  onCancel: () => void;
}) {
  const colors = usePalette();
  return (
    <View
      testID="scrape-progress"
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      <ActivityIndicator size="small" color={colors.accent} />
      <View
        style={{
          width: 96,
          height: 6,
          borderRadius: 3,
          backgroundColor: colors.surfaceSunken,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${phasePercent(state)}%`,
            height: "100%",
            borderRadius: 3,
            backgroundColor: colors.accent,
            ...(Platform.OS === "web"
              ? ({
                  transitionProperty: "width",
                  transitionDuration: `${motion.slow}ms`,
                } as object)
              : null),
          }}
        />
      </View>
      <Text
        style={{
          fontSize: 13,
          color: colors.inkMuted,
          fontVariant: ["tabular-nums"],
        }}
      >
        {phaseLabel(state)}
      </Text>
      <Pressable
        testID="cancel-button"
        accessibilityRole="button"
        onPress={onCancel}
        style={{ minHeight: 28, justifyContent: "center" }}
      >
        <Text style={{ fontSize: 13, fontWeight: "600", color: colors.danger }}>
          Cancel
        </Text>
      </Pressable>
    </View>
  );
}

/** Idle row under the capsule: sample links plus the Options toggle. */
function SampleRow({
  showOptions,
  onPick,
  onToggleOptions,
}: {
  showOptions: boolean;
  onPick: (url: string) => void;
  onToggleOptions: () => void;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      }}
    >
      <Text style={{ fontSize: 12, color: colors.inkMuted }}>Try:</Text>
      {SAMPLES.map((sample) => (
        <Pressable
          key={sample.label}
          accessibilityRole="button"
          accessibilityLabel={`Use ${sample.label} sample link`}
          onPress={() => onPick(sample.url)}
          style={[
            styles.chip,
            { borderColor: colors.border, backgroundColor: colors.surface },
          ]}
        >
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>{sample.label}</Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showOptions }}
        onPress={onToggleOptions}
        style={[
          styles.chip,
          {
            borderColor: showOptions ? "rgba(208, 242, 68, 0.4)" : colors.border,
            backgroundColor: colors.surface,
          },
        ]}
      >
        <Text
          style={{
            fontSize: 12,
            color: showOptions ? colors.accent : colors.inkMuted,
          }}
        >
          Options {showOptions ? "▴" : "▾"}
        </Text>
      </Pressable>
    </View>
  );
}

/** Errors under the capsule: failed-scrape banner and validation message. */
function HeroErrors({
  state,
  message,
  onDismissError,
}: {
  state: ScrapeState;
  message: string | null;
  onDismissError: () => void;
}) {
  const colors = usePalette();
  return (
    <>
      {state.phase === "failed" ? (
        <View
          testID="error-banner"
          accessibilityLiveRegion="assertive"
          style={[
            styles.errorBanner,
            {
              borderColor: "rgba(234, 74, 61, 0.3)",
              backgroundColor: colors.dangerSoft,
            },
          ]}
        >
          <Text
            selectable={true}
            style={{
              color: colors.onDangerSoft,
              fontSize: 13,
              lineHeight: 19,
              flexShrink: 1,
            }}
          >
            {state.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onDismissError}
            style={{ minHeight: 28, justifyContent: "center" }}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.ink }}>
              Dismiss
            </Text>
          </Pressable>
        </View>
      ) : null}
      {message !== null ? (
        <Text
          testID="input-error"
          accessibilityLiveRegion="polite"
          selectable={true}
          style={{
            marginTop: space.md,
            textAlign: "center",
            color: colors.danger,
            fontSize: 13,
            lineHeight: 19,
          }}
        >
          {message}
        </Text>
      ) : null}
    </>
  );
}

interface ScraperHeroProps {
  state: ScrapeState;
  busy: boolean;
  onSubmit: (request: ScrapeRequest) => void;
  onCancel: () => void;
  onDismissError: () => void;
}

/**
 * The reference `ScraperHero`, driven by the real scrape machine: full-height
 * centered stage with ambient lime/grape glows, wordmark + "Scraper online"
 * status, the input capsule with an inline lime CTA, sample chips, and — while
 * a job runs — the live status line with a real progress bar.
 */
export function ScraperHero({
  state,
  busy,
  onSubmit,
  onCancel,
  onDismissError,
}: ScraperHeroProps) {
  const colors = usePalette();
  const { height } = useWindowDimensions();
  const [heroWidth, onHeroLayout] = useContainerWidth();
  // Fits "Turn any app's reviews into clean data." at 44px on one line.
  const wideHeadline = heroWidth >= 960;
  const [input, setInput] = useState("");
  const [limit, setLimit] = useState(100);
  const [sort, setSort] = useState<ReviewSort>("mostRecent");
  const [countryOverride, setCountryOverride] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // The exact input value the settle timer last confirmed — "settled" is
  // derived (settledInput === input), so no setState inside the effect body.
  const [settledInput, setSettledInput] = useState("");
  const [prevInput, setPrevInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // Adjust-during-render (the React-endorsed "previous render" pattern):
  // any keystroke un-settles immediately, even when the text transiently
  // equals an earlier settled value — errors must never flash mid-typing.
  if (prevInput !== input) {
    setPrevInput(input);
    setSettledInput("");
  }

  const validation = validateInput(input);
  const target = validation.ok ? validation.target : null;
  const preview = useAppPreview(target);

  useEffect(() => {
    if (!input.trim()) {
      return;
    }
    const timer = setTimeout(() => setSettledInput(input), ERROR_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const settled = input.trim().length > 0 && settledInput === input;
  const showError =
    !validation.ok && validation.reason !== "empty" && (attempted || settled);
  const emptyAttempt = attempted && !validation.ok && validation.reason === "empty";
  const inputErrorMessage =
    (showError || emptyAttempt) && !validation.ok ? validation.message : null;

  function handleSubmit() {
    setAttempted(true);
    if (busy) {
      return;
    }
    if (!validation.ok) {
      inputRef.current?.focus();
      return;
    }
    if (process.env.EXPO_OS === "ios") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    onSubmit({
      appId: validation.target.appId,
      store: validation.target.store,
      country: countryOverride ?? validation.target.country ?? "us",
      sort,
      limit,
    });
  }

  const canSubmit = !busy && input.trim().length > 0;

  return (
    <View
      onLayout={onHeroLayout}
      style={{
        minHeight: Math.max(height, 620),
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: space.lg,
        paddingVertical: 40,
        overflow: "hidden",
      }}
    >
      <Glow color={colors.accent} size={520} style={{ top: -200, alignSelf: "center" }} />
      {/* The product above the fold: floating mini charts in the side gutters
          (only when there is real gutter space beside the 672px column). */}
      {heroWidth >= 1240 && !busy ? <HeroWidgets /> : null}

      <View style={{ width: "100%", maxWidth: 1000, alignItems: "center" }}>
        {/* Brand: the bolt mark, centered over the glow. */}
        <HeroBrand wideHeadline={wideHeadline} />

        {/* Input capsule */}
        <View style={{ width: "100%", maxWidth: 576, marginTop: 40 }}>
          <View
            style={[
              styles.capsule,
              {
                borderColor: inputFocused
                  ? "rgba(208, 242, 68, 0.6)"
                  : showError || emptyAttempt
                    ? colors.danger
                    : colors.border,
                backgroundColor: colors.surface,
              },
              Platform.OS === "web"
                ? ({
                    boxShadow: inputFocused
                      ? "0 0 0 4px rgba(208, 242, 68, 0.1)"
                      : undefined,
                    transitionProperty: "border-color, box-shadow",
                    transitionDuration: `${motion.fast}ms`,
                  } as object)
                : null,
            ]}
          >
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: radius.md,
                backgroundColor: colors.surfaceSunken,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <LinkIcon size={20} color={colors.inkMuted} />
            </View>
            <TextInput
              ref={inputRef}
              testID="url-input"
              accessibilityLabel="App Store or Google Play URL"
              value={input}
              onChangeText={setInput}
              editable={!busy}
              placeholder="Paste an App Store or Google Play link…"
              placeholderTextColor={colors.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              inputMode="url"
              returnKeyType="go"
              onSubmitEditing={handleSubmit}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              style={{
                flex: 1,
                minWidth: 0,
                paddingHorizontal: 4,
                fontSize: 14,
                color: colors.ink,
                opacity: busy ? 0.6 : 1,
                ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null),
              }}
            />
            <Pressable
              testID="scrape-button"
              accessibilityRole="button"
              accessibilityLabel={busy ? "Scraping" : "Scrape reviews"}
              accessibilityState={{ disabled: busy, busy }}
              onPress={handleSubmit}
              disabled={busy}
              style={(pressState) => {
                const { pressed } = pressState;
                const { focused = false } = pressState as { focused?: boolean };
                return {
                  height: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  borderRadius: radius.md,
                  backgroundColor: colors.accent,
                  paddingHorizontal: 16,
                  opacity: busy || !canSubmit ? 0.55 : pressed ? 0.9 : 1,
                  transform: [{ scale: pressed ? 0.98 : 1 }],
                  ...focusRing(focused, colors.focus),
                  ...(Platform.OS === "web"
                    ? ({
                        cursor: busy ? "default" : "pointer",
                        transitionProperty: "opacity, transform, filter",
                        transitionDuration: `${motion.fast}ms`,
                      } as object)
                    : null),
                };
              }}
            >
              {busy ? (
                <>
                  <ZapIcon size={16} color={colors.onAccent} />
                  <Text
                    style={{ fontSize: 14, fontWeight: "600", color: colors.onAccent }}
                  >
                    Scraping
                  </Text>
                </>
              ) : (
                <>
                  <Text
                    style={{ fontSize: 14, fontWeight: "600", color: colors.onAccent }}
                  >
                    Scrape
                  </Text>
                  <ArrowRightIcon size={16} color={colors.onAccent} />
                </>
              )}
            </Pressable>
          </View>

          {/* Below the capsule: progress while scraping, samples otherwise. */}
          <View style={{ marginTop: space.lg, minHeight: 28 }}>
            {busy ? (
              <ScrapeProgress state={state} onCancel={onCancel} />
            ) : (
              <SampleRow
                showOptions={showOptions}
                onPick={setInput}
                onToggleOptions={() => setShowOptions((open) => !open)}
              />
            )}
          </View>

          {/* Errors (validation or a failed scrape). */}
          <HeroErrors
            state={state}
            message={inputErrorMessage}
            onDismissError={onDismissError}
          />

          {/* Detected app + live preview. */}
          {target && !busy ? (
            <View style={{ marginTop: space.lg, gap: space.md, alignItems: "center" }}>
              <StoreChip
                store={target.store}
                country={countryOverride ?? target.country}
              />
              {preview.status === "ready" ? (
                <View style={{ width: "100%" }}>
                  <AppPreviewCard appInfo={preview.appInfo} />
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Options: limit / sort / storefront as pill rows. */}
          {showOptions && !busy ? (
            <View style={{ marginTop: space.lg, gap: space.md }}>
              <PillRow
                label="Reviews"
                options={LIMITS.map((value) => ({
                  key: String(value),
                  label: String(value),
                }))}
                activeKey={String(limit)}
                onSelect={(key) => setLimit(Number(key))}
              />
              <PillRow
                label="Sort"
                options={SORTS.map((s) => ({ key: s.value, label: s.label }))}
                activeKey={sort}
                onSelect={(key) => setSort(key as ReviewSort)}
              />
              <PillRow
                label="Store"
                options={COUNTRIES.map((code) => ({
                  key: code,
                  label: code.toUpperCase(),
                }))}
                activeKey={countryOverride ?? target?.country ?? "us"}
                onSelect={setCountryOverride}
              />
            </View>
          ) : null}
        </View>

        {/* Feature dots */}
        <View
          style={{
            marginTop: 48,
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "center",
            columnGap: 32,
            rowGap: 12,
          }}
        >
          <FeatureDot label="Sentiment split" />
          <FeatureDot label="Trend & version tracking" />
          <FeatureDot label="Activity heatmap" />
          <FeatureDot label="CSV / JSON export" />
        </View>
      </View>
    </View>
  );
}

/** A labeled row of selectable pills (lime = active), reference filter style. */
function PillRow({
  label,
  options,
  activeKey,
  onSelect,
}: {
  label: string;
  options: Array<{ key: string; label: string }>;
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  const colors = usePalette();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
      }}
    >
      <Text style={{ fontSize: 12, color: colors.inkFaint, marginRight: 4 }}>
        {label}
      </Text>
      {options.map((option) => {
        const active = option.key === activeKey;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="radio"
            aria-checked={active}
            accessibilityLabel={`${label} ${option.label}`}
            onPress={() => onSelect(option.key)}
            style={(pressState) => {
              const { focused = false } = pressState as { focused?: boolean };
              return {
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: active ? colors.accent : colors.border,
                backgroundColor: active ? colors.accent : colors.surfaceSunken,
                paddingHorizontal: 12,
                paddingVertical: 5,
                minHeight: layout.touch - 16,
                justifyContent: "center",
                ...focusRing(focused, colors.focus, 1),
              };
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: active ? "700" : "500",
                color: active ? colors.onAccent : colors.inkMuted,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
