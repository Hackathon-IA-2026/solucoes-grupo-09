import { focusRing, radius, usePalette } from "@wattsteer/ui";
import { Link, usePathname } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useI18n } from "@/i18n";
import {
  LOCALE_LABEL,
  LOCALE_NAME,
  LOCALES,
  type Locale,
  swapLocale,
} from "@/i18n/locale";

/**
 * Compact segmented control that flips the locale. Portuguese is the default.
 *
 * A segmented control rather than a dropdown: there are two options, both are
 * always visible, and the current one is legible at a glance without opening
 * anything.
 *
 * **On a locale-prefixed route it is a link, not a toggle.** `/en/privacy` ⇄
 * `/pt/privacy` — switching language changes the URL, because if it did not
 * the two languages would collapse back into one URL with client state, which
 * is exactly the failure mode the prefixed routes exist to avoid. It still
 * writes the choice to storage on the way, so the gate remembers it next time.
 *
 * On a route with no locale in its URL (`/app`, which is `noindex`) there is
 * nothing to navigate to, so it falls back to the state toggle it used to be.
 */
export function LanguageSwitch({ testID }: { testID?: string }) {
  const colors = usePalette();
  const { locale, routeLocale, setLocale } = useI18n();
  const pathname = usePathname();

  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      accessibilityLabel={locale === "pt" ? "Idioma" : "Language"}
      style={{
        flexDirection: "row",
        alignSelf: "center",
        flexShrink: 0,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: 3,
        gap: 2,
      }}
    >
      {LOCALES.map((option) => {
        const active = option === locale;
        return routeLocale ? (
          <Link key={option} href={swapLocale(pathname, option) as never} asChild={true}>
            <Option
              locale={option}
              active={active}
              // Persist the explicit choice so `/` sends this visitor here
              // next time. The navigation itself is the Link's job.
              onPress={() => setLocale(option)}
            >
              <Chip locale={option} active={active} />
            </Option>
          </Link>
        ) : (
          <Option
            key={option}
            locale={option}
            active={active}
            onPress={() => setLocale(option)}
          >
            <Chip locale={option} active={active} />
          </Option>
        );
      })}
    </View>
  );
}

/**
 * The pressable shell. Split out so `Link asChild` has exactly one child to
 * clone, and so the link and the toggle variants cannot drift apart visually.
 */
function Option({
  locale,
  active,
  onPress,
  children,
  ...rest
}: {
  locale: Locale;
  active: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const colors = usePalette();
  return (
    <Pressable
      {...rest}
      testID={`locale-${locale}`}
      accessibilityRole="radio"
      aria-checked={active}
      accessibilityLabel={LOCALE_NAME[locale]}
      onPress={onPress}
      hitSlop={6}
      style={(state) => {
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          paddingHorizontal: 12,
          paddingVertical: 5,
          borderRadius: radius.pill,
          backgroundColor: active
            ? colors.accent
            : hovered
              ? colors.surfaceSunken
              : "transparent",
          ...focusRing(focused, colors.focus),
          ...(Platform.OS === "web"
            ? ({
                cursor: "pointer",
                transitionProperty: "background-color",
                transitionDuration: "150ms",
              } as object)
            : null),
        };
      }}
    >
      {children}
    </Pressable>
  );
}

function Chip({ locale, active }: { locale: Locale; active: boolean }) {
  const colors = usePalette();
  return (
    <Text
      numberOfLines={1}
      style={{
        fontSize: 12,
        fontWeight: "700",
        letterSpacing: 0.3,
        color: active ? colors.onAccent : colors.inkMuted,
      }}
    >
      {LOCALE_LABEL[locale]}
    </Text>
  );
}
