/**
 * Deterministic brand-asset generator: the WattSteer mark is the W glyph
 * (lime on charcoal). Every favicon / PWA / app / OG asset is rendered from
 * one definition so they stay in lockstep. Rerun after any brand change:
 * `bun scripts/generate-assets.ts` (from apps/web).
 *
 * **The glyph is imported, not read off disk.** It used to be two checked-in
 * master PNGs — `logo-source.png` and `logo-mono-source.png` — which meant the
 * mark existed twice: once as a path in `@wattsteer/ui` and once as pixels
 * here, with nothing holding them together. Importing the paths makes the
 * component the single definition, so a mark that changes in the app cannot
 * fail to change on the favicon.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
// The geometry module by relative path, not through the package barrel: the
// barrel re-exports the components, which import `react-native`, which does not
// parse outside Metro. `lib/mark.ts` has no framework import for this reason.
import {
  WATTSTEER_MARK_BOX as MARK_BOX,
  WATTSTEER_MARK_PATHS,
  wattSteerMarkTransform,
} from "../../../packages/ui/src/lib/mark";

const ROOT = join(import.meta.dir, "..");
const LIME = "#D0F244";
const CHARCOAL = "#131316";
const CARD = "#1B1B1F";
const FG = "#F7F7F7";
const MUTED = "#A2A2AC";
const GRAPE = "#8D5DF6";
const BORDER = "rgba(255,255,255,0.08)";

/** The glyph as inline SVG, at `px` square, in `fill`. */
function glyphImg(px: number, fill = LIME) {
  const paths = WATTSTEER_MARK_PATHS.map((d) => `<path d="${d}" fill="${fill}"/>`).join(
    "",
  );
  // `inset: 1` — the caller has already chosen the box, so the glyph fills it.
  return `<svg width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" xmlns="http://www.w3.org/2000/svg">
      <g transform="${wattSteerMarkTransform(px, 1)}">${paths}</g>
    </svg>`;
}

/**
 * The glyph at its own aspect ratio, tight to its bounding box.
 *
 * The square form above is right for a badge, where the mark sits inside a tile
 * with its own padding. It is wrong for an `<Image>` on a page: a square canvas
 * around a mark that is wider than it is tall is transparent padding, and
 * `contentFit="contain"` then fits the *padding* and renders the mark smaller
 * than the box it was given.
 */
function glyphTight(width: number, fill = LIME) {
  const height = Math.round((width * MARK_BOX.height) / MARK_BOX.width);
  const scale = width / MARK_BOX.width;
  const paths = WATTSTEER_MARK_PATHS.map((d) => `<path d="${d}" fill="${fill}"/>`).join(
    "",
  );
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <g transform="translate(${-MARK_BOX.x * scale}, ${-MARK_BOX.y * scale}) scale(${scale})">${paths}</g>
    </svg>`;
}

/** Charcoal rounded badge + the lime W (favicon / PWA / touch / app icons). */
function badge(size: number, radius: number) {
  return `<div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${CHARCOAL};display:grid;place-items:center">
      ${glyphImg(Math.round(size * 0.6))}
    </div>`;
}

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

interface Asset {
  file: string;
  width: number;
  height: number;
  transparent?: boolean;
  html: string;
}

const ASSETS: Asset[] = [
  {
    // App icon: full-bleed charcoal + lime Z (the OS applies its own mask).
    file: "assets/images/icon.png",
    width: 1024,
    height: 1024,
    html: badge(1024, 0),
  },
  {
    // Favicon = charcoal rounded badge + the lime Z (a badge, not a bare
    // glyph — lime-on-transparent is invisible on light browser tabs).
    file: "assets/images/favicon.png",
    width: 64,
    height: 64,
    transparent: true,
    html: badge(64, 14),
  },
  {
    // The in-page mark: bare lime W on transparent, used by the landing header,
    // the footer and the legal screens through `<Image>`. Generated here for
    // the reason everything else is — it was the last checked-in raster of the
    // logo, so a brand change that did not regenerate it left the old mark on
    // three screens.
    file: "assets/images/logo.png",
    width: 368,
    height: 264,
    transparent: true,
    html: glyphTight(368),
  },
  {
    // Splash mark: bare lime W (the splash background is charcoal).
    file: "assets/images/splash-icon.png",
    width: 512,
    height: 512,
    transparent: true,
    html: `<div style="width:512px;height:512px;display:grid;place-items:center">${glyphImg(300)}</div>`,
  },
  {
    // Adaptive safe zone: lime Z only, centered (background layer is charcoal).
    file: "assets/images/android-icon-foreground.png",
    width: 1024,
    height: 1024,
    transparent: true,
    html: `<div style="width:1024px;height:1024px;display:grid;place-items:center">${glyphImg(560)}</div>`,
  },
  {
    file: "assets/images/android-icon-background.png",
    width: 1024,
    height: 1024,
    html: `<div style="width:1024px;height:1024px;background:${CHARCOAL}"></div>`,
  },
  {
    file: "assets/images/android-icon-monochrome.png",
    width: 1024,
    height: 1024,
    transparent: true,
    html: `<div style="width:1024px;height:1024px;display:grid;place-items:center">${glyphImg(560, FG)}</div>`,
  },
  // PWA-manifest + apple-touch icons: the charcoal badge, scaled. Opaque
  // (iOS fills transparent touch-icon pixels with black anyway).
  ...[
    { file: "public/icon-192.png", size: 192 },
    { file: "public/icon-512.png", size: 512 },
    { file: "public/apple-touch-icon.png", size: 180 },
  ].map(({ file, size }) => ({
    file,
    width: size,
    height: size,
    html: badge(size, 0),
  })),
  {
    file: "public/og.png",
    width: 1200,
    height: 630,
    html: `
      <div style="width:1200px;height:630px;background:${CHARCOAL};position:relative;overflow:hidden;
                  font-family:${FONT};box-sizing:border-box;padding:72px 80px;
                  display:flex;flex-direction:column;justify-content:space-between">
        <div style="position:absolute;top:-260px;left:50%;transform:translateX(-50%);width:640px;height:520px;border-radius:50%;
                    background:radial-gradient(closest-side, ${LIME}, transparent);opacity:0.18;filter:blur(60px)"></div>
        <div style="position:absolute;bottom:-160px;right:-80px;width:420px;height:420px;border-radius:50%;
                    background:radial-gradient(closest-side, ${GRAPE}, transparent);opacity:0.22;filter:blur(60px)"></div>
        <div style="display:flex;align-items:center;gap:16px;position:relative">
          ${glyphImg(56)}
          <span style="font-size:30px;font-weight:600;color:${FG};letter-spacing:-0.5px">WattSteer</span>
        </div>
        <div style="position:relative">
          <div style="font-size:80px;line-height:1.06;font-weight:600;color:${FG};letter-spacing:-2.5px">
            Stop wasting clean energy<br/><span style="color:${LIME}">before it happens.</span>
          </div>
          <div style="margin-top:26px;font-size:28px;line-height:1.4;color:${MUTED};max-width:820px">
            Day-ahead renewable curtailment intelligence for the Brazilian grid.
          </div>
        </div>
        <div style="display:flex;gap:12px;position:relative">
          ${["Every rating & version", "Developer responses", "CSV & JSON"]
            .map(
              (
                chip,
              ) => `<span style="border:2px solid ${BORDER};border-radius:999px;background:${CARD};
                           padding:12px 26px;font-size:22px;font-weight:500;color:${MUTED}">${chip}</span>`,
            )
            .join("")}
        </div>
      </div>`,
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const asset of ASSETS) {
  await page.setViewportSize({ width: asset.width, height: asset.height });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;${asset.transparent ? "background:transparent;" : ""}display:grid;place-items:center">${asset.html}</body></html>`,
  );
  await page.screenshot({
    path: join(ROOT, asset.file),
    omitBackground: asset.transparent ?? false,
    clip: { x: 0, y: 0, width: asset.width, height: asset.height },
  });
  console.log(`✓ ${asset.file} (${asset.width}×${asset.height})`);
}
// favicon.ico — a PNG-in-ICO (valid everywhere modern) so the versioned
// <link rel="icon" href="/favicon.ico?v=N"> in +html.tsx resolves. Rendered
// at 32x32 from the same badge.
await page.setViewportSize({ width: 32, height: 32 });
await page.setContent(
  `<!doctype html><html><body style="margin:0;background:transparent;display:grid;place-items:center">${badge(32, 7)}</body></html>`,
);
const png = await page.screenshot({
  omitBackground: true,
  clip: { x: 0, y: 0, width: 32, height: 32 },
});
const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // one image
header.writeUInt8(32, 6); // width
header.writeUInt8(32, 7); // height
header.writeUInt8(0, 8); // palette
header.writeUInt8(0, 9); // reserved
header.writeUInt16LE(1, 10); // color planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(png.length, 14); // image data size
header.writeUInt32LE(22, 18); // image data offset
writeFileSync(join(ROOT, "public/favicon.ico"), Buffer.concat([header, png]));
console.log("✓ public/favicon.ico (32×32)");

await browser.close();
