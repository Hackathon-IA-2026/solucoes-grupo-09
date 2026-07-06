import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useContainerWidth } from "@/hooks/use-container-width";
import { usePalette } from "@/hooks/use-palette";
import { focusRing } from "@/lib/focus-ring";
import { layout, radius, space, type } from "@/theme/tokens";

/* ---------------------------------- shared ---------------------------------- */

export function SectionHeading({
  kicker,
  title,
  sub,
}: {
  kicker: string;
  title: string;
  sub?: string;
}) {
  const colors = usePalette();
  return (
    <View style={{ gap: space.sm, maxWidth: layout.prose }}>
      <Text
        style={{
          color: colors.accent,
          fontSize: 12,
          fontWeight: "800",
          letterSpacing: 1.2,
          textTransform: "uppercase",
        }}
      >
        {kicker}
      </Text>
      <Text
        accessibilityRole="header"
        aria-level={2}
        style={{
          color: colors.ink,
          fontSize: type.h2.fontSize,
          lineHeight: type.h2.lineHeight,
          fontWeight: "700",
        }}
      >
        {title}
      </Text>
      {sub ? (
        <Text style={{ color: colors.inkMuted, fontSize: 16, lineHeight: 25 }}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

/* ------------------------------- how it works -------------------------------- */

const STEPS = [
  {
    title: "Paste an app link",
    body: "Any App Store or Google Play URL — or just the app id. We detect the store and country for you.",
  },
  {
    title: "We scrape like a human",
    body: "A stealth browser visits the real store page and collects reviews the way a person would — no fragile private APIs.",
  },
  {
    title: "Export and analyze",
    body: "Every review, rating, date and developer response — one click to CSV or JSON, ready for your spreadsheet or LLM.",
  },
];

export function HowItWorks() {
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const row = width >= 820;
  return (
    <View onLayout={onLayout} style={{ gap: space.xl }}>
      <SectionHeading kicker="How it works" title="From link to dataset in three steps" />
      <View style={{ flexDirection: row ? "row" : "column", gap: space.lg }}>
        {STEPS.map((step, index) => (
          <View
            key={step.title}
            style={{
              flex: row ? 1 : undefined,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.lg,
              borderCurve: "continuous",
              padding: space.xl,
              gap: space.md,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: colors.accentSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{ color: colors.onAccentSoft, fontSize: 16, fontWeight: "800" }}
              >
                {index + 1}
              </Text>
            </View>
            <Text style={{ color: colors.ink, fontSize: 17, fontWeight: "700" }}>
              {step.title}
            </Text>
            <Text style={{ color: colors.inkMuted, fontSize: 14, lineHeight: 22 }}>
              {step.body}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* --------------------------------- features ---------------------------------- */

const FEATURES = [
  {
    title: "Both stores, one format",
    body: "Apple and Google reviews come back in a single unified shape — no reconciling two exports.",
  },
  {
    title: "Human-grade stealth",
    body: "Real browser, real fingerprint, human pacing. Scrapes that finish instead of getting blocked.",
  },
  {
    title: "Every field that matters",
    body: "Ratings, titles, bodies, dates, versions, helpful votes and developer responses.",
  },
  {
    title: "Any storefront",
    body: "Scrape the US store or any of 150+ country storefronts — the link's country is honored automatically.",
  },
  {
    title: "CSV & JSON export",
    body: "Clean RFC-4180 CSV for spreadsheets, pretty JSON for pipelines. One click either way.",
  },
  {
    title: "Honest results",
    body: "If a scrape is cut short you're told exactly that — partial data is labeled, never silently truncated.",
  },
];

export function FeatureGrid() {
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const columns = width >= 960 ? 3 : width >= 600 ? 2 : 1;
  return (
    <View onLayout={onLayout} style={{ gap: space.xl }}>
      <SectionHeading
        kicker="Why Noviq"
        title="Built for people who live in review data"
        sub="Product managers, ASO specialists, indie devs and researchers use review mining to find churn reasons, feature requests and competitor gaps."
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        {FEATURES.map((feature) => (
          <View
            key={feature.title}
            style={{
              flexBasis: columns === 1 ? "100%" : columns === 2 ? "47%" : "31%",
              flexGrow: 1,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.lg,
              borderCurve: "continuous",
              padding: space.xl,
              gap: space.sm,
            }}
          >
            <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "700" }}>
              {feature.title}
            </Text>
            <Text style={{ color: colors.inkMuted, fontSize: 14, lineHeight: 22 }}>
              {feature.body}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ------------------------------------ FAQ ------------------------------------ */

const FAQS = [
  {
    q: "Is this legal?",
    a: "Noviq reads the same public store pages anyone can open in a browser. It collects only public reviews — no accounts, no private data. You're responsible for how you use the exported data.",
  },
  {
    q: "How many reviews can I scrape?",
    a: "Up to 500 per run today. Runs are sorted newest-first by default, so repeated runs with a date filter can build a complete history.",
  },
  {
    q: "Which countries and languages work?",
    a: "Any storefront either store offers. Paste a link with a country in it (like apps.apple.com/de/…) and that storefront is used automatically, or pick one under More options.",
  },
  {
    q: "Why do scrapes take a minute?",
    a: "We drive a real browser at human pace on purpose — it's what keeps scrapes reliable instead of rate-limited. Small runs usually finish in well under a minute.",
  },
  {
    q: "What do I get in the export?",
    a: "Reviewer name, rating, title, body, date, app version, helpful votes, developer responses, and the store/country/app id for provenance — as CSV or JSON.",
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const colors = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        borderCurve: "continuous",
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={open ? "Collapses the answer" : "Expands the answer"}
        onPress={() => setOpen((value) => !value)}
        style={(state) => {
          const { focused = false } = state as { focused?: boolean };
          return {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            padding: space.lg,
            minHeight: layout.touch,
            gap: space.md,
            ...focusRing(focused, colors.focus, -2),
          };
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 15, fontWeight: "700", flex: 1 }}>
          {q}
        </Text>
        <Text style={{ color: colors.inkFaint, fontSize: 14 }}>{open ? "−" : "+"}</Text>
      </Pressable>
      {open ? (
        <Text
          selectable
          style={{
            color: colors.inkMuted,
            fontSize: 14,
            lineHeight: 22,
            paddingHorizontal: space.lg,
            paddingBottom: space.lg,
          }}
        >
          {a}
        </Text>
      ) : null}
    </View>
  );
}

export function Faq() {
  return (
    <View style={{ gap: space.xl }}>
      <SectionHeading kicker="FAQ" title="Questions, answered" />
      <View style={{ gap: space.md, maxWidth: layout.prose, width: "100%" }}>
        {FAQS.map((item) => (
          <FaqItem key={item.q} q={item.q} a={item.a} />
        ))}
      </View>
    </View>
  );
}

/** FAQ content exported for the JSON-LD structured data in the route head. */
export const FAQ_ENTRIES = FAQS;

/* ---------------------------------- footer ----------------------------------- */

export function SiteFooter() {
  const colors = usePalette();
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingVertical: space.xl,
        gap: space.sm,
      }}
    >
      <Text style={{ color: colors.inkMuted, fontSize: 14, fontWeight: "700" }}>
        Noviq
      </Text>
      <Text style={{ color: colors.inkFaint, fontSize: 13, lineHeight: 20 }}>
        App review scraping for App Store & Google Play. Public data only — not affiliated
        with Apple Inc. or Google LLC.
      </Text>
      <Text style={{ color: colors.inkFaint, fontSize: 13 }}>
        © {new Date().getFullYear()} Noviq
      </Text>
    </View>
  );
}
