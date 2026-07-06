import {
  type ReviewSort,
  type ScrapeRequest,
  type ScrapeState,
  validateInput,
} from "@noviq/core";
import {
  ArrowRightIcon,
  focusRing,
  gradientBg,
  LinkIcon,
  layout,
  motion,
  NoviqWordmark,
  radius,
  SparklesIcon,
  space,
  usePalette,
  ZapIcon,
} from "@noviq/ui";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useAppPreview } from "@/hooks/use-app-preview";
import { AppPreviewCard } from "./app-preview-card";
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
  if (state.phase === "submitting") return 6;
  if (state.phase === "queued") return 12;
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
      pointerEvents="none"
      aria-hidden
      style={{
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
  const [input, setInput] = useState("");
  const [limit, setLimit] = useState(100);
  const [sort, setSort] = useState<ReviewSort>("mostRecent");
  const [countryOverride, setCountryOverride] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [settled, setSettled] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const validation = useMemo(() => validateInput(input), [input]);
  const target = useMemo(() => (validation.ok ? validation.target : null), [validation]);
  const preview = useAppPreview(target);

  useEffect(() => {
    setSettled(false);
    if (!input.trim()) return;
    const timer = setTimeout(() => setSettled(true), ERROR_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const showError =
    !validation.ok && validation.reason !== "empty" && (attempted || settled);
  const emptyAttempt = attempted && !validation.ok && validation.reason === "empty";

  function handleSubmit() {
    setAttempted(true);
    if (busy) return;
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
      <Glow color={colors.violet} size={380} style={{ bottom: -80, right: -80 }} />

      {/* Top bar */}
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: space.xl,
        }}
      >
        <NoviqWordmark />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: colors.accent,
            }}
          />
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>Scraper online</Text>
        </View>
      </View>

      <View style={{ width: "100%", maxWidth: 672, alignItems: "center" }}>
        {/* Kicker */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
            paddingHorizontal: 12,
            paddingVertical: 6,
            marginBottom: space.xl,
          }}
        >
          <SparklesIcon size={14} color={colors.accent} />
          <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
            Review intelligence, in seconds
          </Text>
        </View>

        <Text
          accessibilityRole="header"
          aria-level={1}
          style={{
            textAlign: "center",
            color: colors.ink,
            fontSize: 44,
            lineHeight: 48,
            fontWeight: "600",
            letterSpacing: -1.2,
            maxWidth: 640,
          }}
        >
          Turn any app's reviews into
          <Text style={{ color: colors.accent }}> clean data.</Text>
        </Text>
        <Text
          style={{
            marginTop: space.lg,
            textAlign: "center",
            color: colors.inkMuted,
            fontSize: 16,
            lineHeight: 25,
            maxWidth: 512,
          }}
        >
          Noviq pulls every review from the App Store and Google Play, scores sentiment,
          and tracks trends, versions and busy hours — a full analytics dashboard from a
          single link.
        </Text>

        {/* Input capsule */}
        <View style={{ width: "100%", maxWidth: 576, marginTop: 36 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: inputFocused
                ? "rgba(208, 242, 68, 0.6)"
                : showError || emptyAttempt
                  ? colors.danger
                  : colors.border,
              backgroundColor: colors.surface,
              padding: 8,
              ...(Platform.OS === "web"
                ? ({
                    boxShadow: inputFocused
                      ? "0 0 0 4px rgba(208, 242, 68, 0.1)"
                      : undefined,
                    transitionProperty: "border-color, box-shadow",
                    transitionDuration: `${motion.fast}ms`,
                  } as object)
                : null),
            }}
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
            ) : (
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
                    onPress={() => setInput(sample.url)}
                    style={{
                      borderRadius: radius.pill,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: colors.surface,
                      paddingHorizontal: 12,
                      paddingVertical: 5,
                      minHeight: 28,
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ fontSize: 12, color: colors.inkMuted }}>
                      {sample.label}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showOptions }}
                  onPress={() => setShowOptions((open) => !open)}
                  style={{
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: showOptions ? "rgba(208, 242, 68, 0.4)" : colors.border,
                    backgroundColor: colors.surface,
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                    minHeight: 28,
                    justifyContent: "center",
                  }}
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
            )}
          </View>

          {/* Errors (validation or a failed scrape). */}
          {state.phase === "failed" ? (
            <View
              testID="error-banner"
              accessibilityLiveRegion="assertive"
              style={{
                marginTop: space.md,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                flexWrap: "wrap",
                gap: space.md,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: "rgba(234, 74, 61, 0.3)",
                backgroundColor: colors.dangerSoft,
                padding: space.md,
              }}
            >
              <Text
                selectable
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
          {showError || emptyAttempt ? (
            <Text
              testID="input-error"
              accessibilityLiveRegion="polite"
              selectable
              style={{
                marginTop: space.md,
                textAlign: "center",
                color: colors.danger,
                fontSize: 13,
                lineHeight: 19,
              }}
            >
              {validation.ok ? "" : validation.message}
            </Text>
          ) : null}

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
            accessibilityState={{ selected: active }}
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
