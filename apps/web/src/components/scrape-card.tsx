import { type ReviewSort, type ScrapeRequest, validateInput } from "@noviq/core";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useAppPreview } from "@/hooks/use-app-preview";
import { usePalette } from "@/hooks/use-palette";
import { focusRing } from "@/lib/focus-ring";
import { motion, radius, space } from "@/theme/tokens";
import { AppPreviewCard } from "./app-preview-card";
import { Button } from "./button";
import { KickerPill } from "./kicker-pill";
import { SegControl } from "./seg-control";
import { SparkChip } from "./spark-chip";
import { StoreChip } from "./store-chip";

const LIMITS = [
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 200, label: "200" },
  { value: 500, label: "500" },
] as const;

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

interface ScrapeCardProps {
  busy: boolean;
  onSubmit: (request: ScrapeRequest) => void;
}

/**
 * The conversion surface: one input, one primary action (Hick's law), with
 * limit visible and everything else behind "More options" (Tesler — we absorb
 * the complexity). Valid input instantly shows the detected store + a live
 * app preview; errors are specific and appear only after typing settles.
 */
export function ScrapeCard({ busy, onSubmit }: ScrapeCardProps) {
  const colors = usePalette();
  const [input, setInput] = useState("");
  const [limit, setLimit] = useState<number>(100);
  const [sort, setSort] = useState<ReviewSort>("mostRecent");
  const [countryOverride, setCountryOverride] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [settled, setSettled] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const validation = useMemo(() => validateInput(input), [input]);
  // Memoized off `validation` so unrelated re-renders keep the same identity
  // and don't restart the preview debounce.
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

  return (
    <View
      testID="scrape-card"
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        padding: space.xl,
        gap: space.lg,
        width: "100%",
        boxShadow: colors.shadowFloat,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.md,
        }}
      >
        <View style={{ gap: space.sm, flexShrink: 1 }}>
          <KickerPill label="Free — no signup" />
          <Text style={{ color: colors.ink, fontSize: 22, fontWeight: "800" }}>
            Start a scrape
          </Text>
        </View>
        <SparkChip size={44} />
      </View>

      <View style={{ gap: space.sm }}>
        <Text
          nativeID="app-url-label"
          style={{ color: colors.inkMuted, fontSize: 13, fontWeight: "600" }}
        >
          App Store or Google Play link
        </Text>
        <TextInput
          ref={inputRef}
          testID="url-input"
          accessibilityLabelledBy="app-url-label"
          accessibilityLabel="App Store or Google Play link"
          value={input}
          onChangeText={setInput}
          editable={!busy}
          placeholder="https://apps.apple.com/us/app/…  or  com.spotify.music"
          placeholderTextColor={colors.inkFaint}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          inputMode="url"
          returnKeyType="go"
          onSubmitEditing={handleSubmit}
          style={{
            minHeight: 52,
            borderWidth: 1.5,
            borderColor: showError || emptyAttempt ? colors.danger : colors.border,
            borderRadius: radius.md,
            borderCurve: "continuous",
            paddingHorizontal: space.lg,
            fontSize: 16,
            color: colors.ink,
            backgroundColor: colors.surfaceSunken,
            ...(Platform.OS === "web"
              ? ({
                  // Soft violet focus glow instead of a hard outline.
                  outlineStyle: "none",
                  boxShadow: inputFocused
                    ? `0 0 0 3px ${colors.accentSoft}, 0 0 0 1.5px ${colors.focus}`
                    : undefined,
                  transitionProperty: "box-shadow, border-color",
                  transitionDuration: `${motion.fast}ms`,
                } as object)
              : null),
          }}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
        />

        {/* Live feedback row: detected store chip, or a specific error. */}
        {target ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <StoreChip store={target.store} country={countryOverride ?? target.country} />
            <Text style={{ color: colors.inkFaint, fontSize: 13 }} numberOfLines={1}>
              {target.appId}
            </Text>
          </View>
        ) : null}
        {showError || emptyAttempt ? (
          <Text
            testID="input-error"
            accessibilityLiveRegion="polite"
            selectable
            style={{ color: colors.danger, fontSize: 13, lineHeight: 19 }}
          >
            {validation.ok ? "" : validation.message}
          </Text>
        ) : null}

        {preview.status === "ready" ? <AppPreviewCard appInfo={preview.appInfo} /> : null}
      </View>

      <SegControl
        label="Reviews to fetch"
        options={LIMITS}
        value={limit}
        onChange={setLimit}
        disabled={busy}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showOptions }}
        onPress={() => setShowOptions((open) => !open)}
        style={(state) => {
          const { focused = false } = state as { focused?: boolean };
          return {
            minHeight: 32,
            justifyContent: "center",
            alignSelf: "flex-start",
            ...focusRing(focused, colors.focus),
          };
        }}
      >
        <Text style={{ color: colors.inkMuted, fontSize: 14, fontWeight: "600" }}>
          {showOptions ? "Hide options ▴" : "More options ▾"}
        </Text>
      </Pressable>

      {showOptions ? (
        <View style={{ gap: space.lg }}>
          <SegControl
            label="Sort by"
            options={SORTS}
            value={sort}
            onChange={setSort}
            disabled={busy}
          />
          <View style={{ gap: space.sm }}>
            <Text style={{ color: colors.inkMuted, fontSize: 13, fontWeight: "600" }}>
              Storefront country
              {target?.country && !countryOverride ? "  (from your link)" : ""}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {COUNTRIES.map((code) => {
                const active = (countryOverride ?? target?.country ?? "us") === code;
                return (
                  <Pressable
                    key={code}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active, disabled: busy }}
                    accessibilityLabel={`Country ${code.toUpperCase()}`}
                    disabled={busy}
                    onPress={() => setCountryOverride(code)}
                    style={(state) => {
                      const { focused = false } = state as { focused?: boolean };
                      return {
                        minWidth: 44,
                        minHeight: 36,
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: radius.sm,
                        borderCurve: "continuous",
                        borderWidth: 1,
                        borderColor: active ? colors.accent : colors.border,
                        backgroundColor: active ? colors.accentSoft : "transparent",
                        ...focusRing(focused, colors.focus, 1),
                      };
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: "700",
                        color: active ? colors.onAccentSoft : colors.inkMuted,
                      }}
                    >
                      {code.toUpperCase()}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      ) : null}

      <Button
        testID="scrape-button"
        label={busy ? "Scraping…" : "Scrape reviews"}
        onPress={handleSubmit}
        loading={busy}
        fluid
        accessibilityHint="Starts scraping reviews for the app link above"
      />

      <Text style={{ color: colors.inkFaint, fontSize: 12, textAlign: "center" }}>
        Reads public store pages only. Typically 30–90 seconds.
      </Text>
    </View>
  );
}
