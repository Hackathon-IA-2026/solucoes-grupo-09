import {
  ArrowRightIcon,
  Badge,
  FadeIn,
  RiskBar,
  radius,
  ShieldCheckIcon,
  usePalette,
} from "@negotiatio/ui";
import { useRouter } from "expo-router";
import { memo } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useI18n } from "@/i18n";
import { formatCurrency, formatDate, formatPercent } from "@/i18n/format";
import { categoryTone, type Offer } from "@/lib/offers";
import { IssuerLogo } from "./issuer-logo";

/** A labeled metric cell (label above, value below). */
function Field({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  const colors = usePalette();
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={{ fontSize: 12, color: colors.inkMuted, marginBottom: 3 }}>
        {label}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          fontSize: 15,
          fontWeight: "600",
          color: accent ? colors.accent : colors.ink,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * Memoized: with hundreds of cards in the grid, extending the scroll window
 * must not re-render (and re-measure) every already-mounted card.
 */
export const OfferCard = memo(function OfferCard({
  offer,
  delay = 0,
}: {
  offer: Offer;
  delay?: number;
}) {
  const colors = usePalette();
  const router = useRouter();
  const { t, tEnum, locale } = useI18n();
  const riskLabel = tEnum("risk", offer.riskKey);

  const go = () =>
    router.push({ pathname: "/produto/[slug]", params: { slug: offer.slug } });

  return (
    <FadeIn delay={delay} distance={16} duration={420}>
      <Pressable
        onPress={go}
        accessibilityRole="button"
        accessibilityLabel={offer.name}
        style={(state) => {
          const { hovered = false, pressed = false } = state as {
            hovered?: boolean;
            pressed?: boolean;
          };
          return {
            borderRadius: radius.xl,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: hovered ? colors.borderStrong : colors.border,
            backgroundColor: colors.surface,
            padding: 20,
            gap: 14,
            transform: [{ translateY: hovered ? -3 : 0 }, { scale: pressed ? 0.99 : 1 }],
            ...(Platform.OS === "web"
              ? ({
                  cursor: "pointer",
                  boxShadow: hovered ? colors.shadowFloat : colors.shadowCard,
                  transitionProperty: "transform, border-color, box-shadow",
                  transitionDuration: "180ms",
                } as object)
              : null),
          };
        }}
      >
        {/* Header: logo + name */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <IssuerLogo uri={offer.thumbnail} name={offer.issuer || offer.name} />
          <Text
            numberOfLines={2}
            style={{
              flex: 1,
              fontSize: 17,
              lineHeight: 22,
              fontWeight: "700",
              color: colors.ink,
            }}
          >
            {offer.name}
          </Text>
        </View>

        {/* Type + FGC badges */}
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}
        >
          <Badge label={offer.type} tone={categoryTone(offer.category)} />
          {offer.fgc ? (
            <Badge
              label="FGC"
              tone="neutral"
              icon={<ShieldCheckIcon size={12} color={colors.inkMuted} />}
            />
          ) : null}
        </View>

        {/* Minimum investment */}
        <View>
          <Text style={{ fontSize: 12, color: colors.inkMuted, marginBottom: 3 }}>
            {t("card.minInvestment")}
          </Text>
          <Text style={{ fontSize: 20, fontWeight: "700", color: colors.ink }}>
            {formatCurrency(offer.minInvestment, locale)}
          </Text>
        </View>

        {/* Yields */}
        <View style={{ flexDirection: "row", gap: 12 }}>
          <Field
            label={t("card.grossYield")}
            value={`${formatPercent(offer.grossYield, locale)} ${t("card.perYear")}`}
          />
          <Field
            label={t("card.netYield")}
            value={`${formatPercent(offer.netYield, locale)} ${t("card.perYear")}`}
            accent
          />
        </View>

        {/* Distributor + issuer */}
        <View style={{ flexDirection: "row", gap: 12 }}>
          <Field label={t("card.distributor")} value={offer.distributor || "—"} />
          <Field label={t("card.issuer")} value={offer.issuer || "—"} />
        </View>

        {/* Liquidity + maturity */}
        <View style={{ flexDirection: "row", gap: 12 }}>
          <Field
            label={t("card.liquidity")}
            value={tEnum("liquidity", offer.liquidity)}
          />
          <Field
            label={t("card.maturity")}
            value={formatDate(offer.maturity, offer.maturityTs, locale)}
          />
        </View>

        {/* Risk */}
        <View>
          <Text style={{ fontSize: 12, color: colors.inkMuted, marginBottom: 6 }}>
            {t("card.risk")}
          </Text>
          <RiskBar value={offer.riskScore} />
          <Text
            style={{ fontSize: 13, fontWeight: "600", color: colors.ink, marginTop: 2 }}
          >
            {riskLabel === offer.riskKey ? offer.riskLabel : riskLabel}
          </Text>
        </View>

        {/* Details affordance */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            marginTop: 2,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.pill,
            paddingVertical: 10,
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
            {t("card.details")}
          </Text>
          <ArrowRightIcon size={15} color={colors.ink} />
        </View>
      </Pressable>
    </FadeIn>
  );
});
