import { ArrowRightIcon, layout, Panel, radius, space, usePalette } from "@wattsteer/ui";
import { Image } from "expo-image";
import { View } from "react-native";
import { useCopy } from "@/i18n";
import { PITCH_PATH } from "@/lib/pitch";
import { CtaLink } from "./cta-link";
import { SectionHeading } from "./section";

/**
 * The deck, at the bottom of the landing page.
 *
 * A visitor who has read the whole page has read the argument in the product's
 * own order; the deck is the same argument in the order it was first made, and
 * the end of the page is where somebody who wants that is standing. It reuses
 * `/pitch`'s own `title` and `lede` rather than inventing a second description
 * of one document — the only strings this section adds are the button and the
 * image's alternative text.
 *
 * ## The PDF is not embedded here, and these are the three measured reasons
 *
 * 1. **A wheel over a PDF iframe scrolls the PDF, not the page.** On `/pitch`
 *    the embed is the entire point of the route, so a reader who lands on it
 *    expects their wheel to drive the deck. Mid-page it is a scroll trap: the
 *    pointer crosses into the frame on the way down the landing page and the
 *    page stops moving, with the section below it and no indication why.
 * 2. **706,193 bytes, for every visitor.** That is the committed deck,
 *    measured (see `lib/pitch.ts`) — the second-largest tracked file in the
 *    repository. `/pitch` is a page somebody chose to open; the landing page
 *    is the one a link drops them on, on a phone, on mobile data. The slide
 *    below is 34,266 bytes, which is 4.9% of it, and it is the whole of what
 *    an embed would have shown before the first scroll anyway.
 * 3. **`/pitch` is `noindex`; this page is the one that is indexed.** The deck
 *    frame carries `noindex,follow` because its only content is a PDF that is
 *    crawlable on its own. Embedding that same PDF in the indexed page would
 *    put 706 KB of uncrawlable iframe in the middle of the document search
 *    engines actually read, in place of the text that earns the ranking.
 *
 * So: the title, the lede, one slide, and a prominent way to `/pitch`.
 */
export function Deck({ wide }: { wide: boolean }) {
  const copy = useCopy();

  return (
    <>
      <SectionHeading title={copy.pitch.title} sub={copy.pitch.lede} wide={wide} />

      <View style={{ alignItems: "center", gap: space.xl }}>
        <DeckSlide alt={copy.pitch.slideAlt} />
        <CtaLink
          testID="deck-open"
          href={PITCH_PATH}
          label={copy.pitch.sectionCta}
          primary={true}
          icon={<CtaArrow />}
        />
      </View>
    </>
  );
}

/** The arrow on the primary pill, in the fill's contrast colour. */
function CtaArrow() {
  const colors = usePalette();
  return <ArrowRightIcon size={16} color={colors.onAccent} />;
}

/**
 * The deck's first slide, as a picture of itself.
 *
 * `require`d rather than served from `public/` like the PDF is, and the
 * difference is the failure mode: a bundled asset that went missing is a build
 * error, while `public/wattsteer-pitch.pdf` is in the module graph of nothing
 * and needs `scripts/localize-export.ts` to notice it is gone. A decorative
 * image does not warrant a second entry on that list, so it is put where the
 * bundler can see it instead.
 *
 * Rendered from the committed PDF at 72 dpi — `pdftoppm -png -r 72 -f 1 -l 1`,
 * then `cwebp -q 80` — which is the slide's own 1080 × 608 pixel box, so it is
 * 2× at the 540 px the frame is at its widest and there is no second file to
 * keep in step. 34,266 bytes against 93,830 for the same frame as a PNG.
 *
 * The aspect ratio is the deck's own `/MediaBox [0 0 1080 607.92]`, stated as
 * 16:9, so the box is the right height before the bytes arrive and nothing on
 * the page below it moves when they do.
 */
function DeckSlide({ alt }: { alt: string }) {
  const colors = usePalette();
  return (
    <Panel
      testID="deck-slide"
      style={{
        padding: space.sm,
        width: "100%",
        // A slide is a picture, not a column of prose, and at the full 1,248 px
        // content width it would be the largest thing on the page by some way
        // — louder than the hero's own chart. `layout.prose` is the measure the
        // section's lede is already set to, so the slide lines up with the text
        // above it instead of bracketing it.
        maxWidth: layout.prose,
      }}
    >
      <Image
        source={require("../../../assets/images/pitch-slide-1.webp")}
        // 16:9 to three decimals, from the deck's MediaBox. `width: "100%"`
        // with an aspect ratio rather than a fixed height: at 400 px the panel
        // is ~360 px wide and the slide has to come with it.
        style={{
          width: "100%",
          aspectRatio: 16 / 9,
          borderRadius: radius.md,
          backgroundColor: colors.surfaceSunken,
        }}
        contentFit="contain"
        // One of the two, not both: expo-image documents `alt` as an alias for
        // `accessibilityLabel`, and either sets the web `alt` attribute. This
        // is the spelling the rest of the site already uses.
        accessibilityLabel={alt}
      />
    </Panel>
  );
}
