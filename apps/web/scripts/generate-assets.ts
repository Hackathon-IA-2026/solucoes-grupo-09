/**
 * Deterministic brand-asset generator: the WattSteer mark is the script "Z"
 * glyph (lime on charcoal). Every favicon / PWA / app / OG asset is rendered
 * from a single hi-res transparent glyph so they stay in lockstep. Rerun after
 * any brand change: `bun scripts/generate-assets.ts` (from apps/web).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(import.meta.dir, "..");
const LIME = "#D0F244";
const CHARCOAL = "#131316";
const CARD = "#1B1B1F";
const FG = "#F7F7F7";
const MUTED = "#A2A2AC";
const GRAPE = "#8D5DF6";
const BORDER = "rgba(255,255,255,0.08)";

/** The lime Z glyph (transparent) — the master brand mark. */
const GLYPH = readFileSync(join(ROOT, "assets/images/logo-source.png")).toString(
  "base64",
);
/** White Z glyph, for the Android themed (monochrome) icon layer. */
const GLYPH_MONO = readFileSync(
  join(ROOT, "assets/images/logo-mono-source.png"),
).toString("base64");

/** A bare, centered glyph at `px` (square, contain). */
function glyphImg(px: number, b64 = GLYPH) {
  return `<img src="data:image/png;base64,${b64}" style="width:${px}px;height:${px}px;object-fit:contain" alt="" />`;
}

/** Charcoal rounded badge + the lime Z (favicon / PWA / touch / app icons). */
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
    // Splash mark: bare lime Z (the splash background is charcoal).
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
    html: `<div style="width:1024px;height:1024px;display:grid;place-items:center">${glyphImg(560, GLYPH_MONO)}</div>`,
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
