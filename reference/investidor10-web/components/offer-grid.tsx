import { useContainerWidth } from "@negotiatio/ui";
import { View } from "react-native";
import type { Offer } from "@/lib/offers";
import { OfferCard } from "./offer-card";

const GAP = 16;

/** Column count from measured container width (mobile-first). */
function columnsFor(width: number): number {
  if (width < 640 || width === 0) {
    return 1;
  }
  if (width < 1024) {
    return 2;
  }
  return 3;
}

export function OfferGrid({ offers }: { offers: Offer[] }) {
  const [width, onLayout] = useContainerWidth();
  const cols = columnsFor(width);
  const cardWidth = width > 0 && cols > 1 ? (width - GAP * (cols - 1)) / cols : undefined;

  return (
    <View
      onLayout={onLayout}
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: GAP,
        alignItems: "flex-start",
      }}
    >
      {offers.map((offer, i) => (
        <View key={offer.id} style={cardWidth ? { width: cardWidth } : { width: "100%" }}>
          <OfferCard offer={offer} delay={Math.min(i, cols * 3) * 45} />
        </View>
      ))}
    </View>
  );
}
