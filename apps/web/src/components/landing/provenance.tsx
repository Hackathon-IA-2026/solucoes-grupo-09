import {
  IconCircle,
  LinkIcon,
  Panel,
  radius,
  space,
  usePalette,
  XIcon,
} from "@wattsteer/ui";
import { Text, View } from "react-native";
import { useCopy } from "@/i18n";
import { SectionHeading } from "./section";

/**
 * Where the data comes from, and what the product refuses to say.
 *
 * This section has no equivalent in the reference landing page, and it is
 * the one that most needed inventing. Two reasons it earns its space rather
 * than living in the footer:
 *
 * 1. **The map treats honesty about data as a product value, not a nicety.**
 *    A public, read-only forecasting site whose whole claim is "we show our
 *    working" cannot bury the working.
 * 2. **The ODbL notice is an obligation, not a courtesy.** WattSteer's plant
 *    table is a Derivative Database and the public charts are Publicly Used
 *    Produced Works, so §4.3 requires the notice on public surfaces from day
 *    one — not at monetisation. It is rendered as visible body text here, not
 *    as a legal-page link, because that is what §4.3 asks for.
 *
 * The "will not claim" list is the same argument in the other direction:
 * every item is a number the product could plausibly have shown and
 * deliberately does not.
 */
export function Provenance({ wide }: { wide: boolean }) {
  const copy = useCopy();
  const colors = usePalette();
  const basis: `${number}%` = wide ? "31%" : "100%";

  return (
    <>
      <SectionHeading
        title={copy.provenance.title}
        sub={copy.provenance.sub}
        wide={wide}
      />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        {copy.provenance.sources.map((source) => (
          <Panel
            key={source.name}
            style={{ flexGrow: 1, flexBasis: basis, gap: space.md }}
          >
            <IconCircle>
              <LinkIcon size={18} color={colors.accent} />
            </IconCircle>
            <Text style={{ fontSize: 16, fontWeight: "600", color: colors.ink }}>
              {source.name}
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 22, color: colors.inkMuted }}>
              {source.body}
            </Text>
          </Panel>
        ))}
      </View>

      <Panel style={{ gap: space.lg }}>
        <Text style={{ fontSize: 20, fontWeight: "600", color: colors.ink }}>
          {copy.provenance.honesty.title}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          {copy.provenance.honesty.items.map((item) => (
            <View
              key={item.label}
              style={{ flexGrow: 1, flexBasis: wide ? "45%" : "100%", gap: 8 }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.dangerSoft,
                  }}
                >
                  <XIcon size={13} color={colors.onDangerSoft} />
                </View>
                <Text style={{ fontSize: 15, fontWeight: "600", color: colors.ink }}>
                  {item.label}
                </Text>
              </View>
              <Text style={{ fontSize: 14, lineHeight: 22, color: colors.inkMuted }}>
                {item.body}
              </Text>
            </View>
          ))}
        </View>
      </Panel>

      <View
        testID="odbl-notice"
        style={{
          gap: space.sm,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.canvasTint,
          padding: 16,
        }}
      >
        <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkMuted }}>
          {copy.provenance.odbl}
        </Text>
        <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
          {copy.provenance.disclaimer}
        </Text>
      </View>
    </>
  );
}
