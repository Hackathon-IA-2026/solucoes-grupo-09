/**
 * Deterministic brand-asset generator (design system v3, ported from the
 * reference app): the ZalytixMark — lime rounded square with the stroked
 * Z-path — on charcoal. Rerun after any brand change:
 * `bun scripts/generate-assets.ts` (from apps/web).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(import.meta.dir, "..");
const LIME = "#D0F244";
const ON_LIME = "#1E2B10";
const CHARCOAL = "#131316";
const CARD = "#1B1B1F";
const FG = "#F7F7F7";
const MUTED = "#A2A2AC";
const GRAPE = "#8D5DF6";
const BORDER = "rgba(255,255,255,0.08)";

/** Hi-res bolt mark, base64-encoded once and shared by every badge asset. */
const BOLT_B64 = readFileSync(join(ROOT, "assets/images/bolt-logo-source.png")).toString(
  "base64",
);

/** Charcoal rounded badge + bolt mark at any size (favicon/PWA/touch icons). */
function badge(size: number, radius: number) {
  return `<div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${CHARCOAL};display:grid;place-items:center">
      <img src="data:image/png;base64,${BOLT_B64}" style="width:${Math.round(size * 0.66)}px;height:${Math.round(size * 0.72)}px;object-fit:contain" />
    </div>`;
}

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The reference ZalytixMark: rounded square + stroked Z-path. */
function mark(
  size: number,
  opts: { bg?: string; stroke?: string; radius?: number } = {},
) {
  const { bg = LIME, stroke = ON_LIME } = opts;
  const rx = opts.radius ?? 9;
  return `
  <svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:${size}px;height:${size}px">
    <rect width="32" height="32" rx="${rx}" fill="${bg}"/>
    <path d="M9 9H23L9 23H23" stroke="${stroke}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

interface Asset {
  file: string;
  width: number;
  height: number;
  transparent?: boolean;
  html: string;
}

const ASSETS: Asset[] = [
  {
    file: "assets/images/icon.png",
    width: 1024,
    height: 1024,
    html: mark(1024, { radius: 0 }),
  },
  {
    // Favicon = charcoal rounded badge + the bolt mark. A badge, not a bare
    // glyph — lime-on-transparent is invisible on light browser tabs.
    // Icons render from bolt-logo-source.png (hi-res, extracted from the
    // brand image); the bundled bolt-logo.png is the same mark downscaled to
    // 2x its largest display size to keep the web payload small.
    file: "assets/images/favicon.png",
    width: 64,
    height: 64,
    transparent: true,
    html: badge(64, 14),
  },
  {
    file: "assets/images/splash-icon.png",
    width: 512,
    height: 512,
    transparent: true,
    html: `<div style="width:512px;height:512px;display:grid;place-items:center">${mark(320)}</div>`,
  },
  {
    file: "assets/images/android-icon-foreground.png",
    width: 1024,
    height: 1024,
    transparent: true,
    // Adaptive safe zone: Z-path only, centered (background layer is lime).
    html: `<div style="width:1024px;height:1024px;display:grid;place-items:center">
      <svg width="560" height="560" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 9H23L9 23H23" stroke="${ON_LIME}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg></div>`,
  },
  {
    file: "assets/images/android-icon-background.png",
    width: 1024,
    height: 1024,
    html: `<div style="width:1024px;height:1024px;background:${LIME}"></div>`,
  },
  {
    file: "assets/images/android-icon-monochrome.png",
    width: 1024,
    height: 1024,
    transparent: true,
    html: `<div style="width:1024px;height:1024px;display:grid;place-items:center">
      <svg width="560" height="560" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 9H23L9 23H23" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg></div>`,
  },
  // PWA-manifest + apple-touch icons: the favicon badge, scaled. Opaque
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
          ${mark(56)}
          <span style="font-size:30px;font-weight:600;color:${FG};letter-spacing:-0.5px">Zalytix</span>
        </div>
        <div style="position:relative">
          <div style="font-size:80px;line-height:1.06;font-weight:600;color:${FG};letter-spacing:-2.5px">
            Turn any app's reviews<br/>into <span style="color:${LIME}">clean data.</span>
          </div>
          <div style="margin-top:26px;font-size:28px;line-height:1.4;color:${MUTED};max-width:820px">
            App Store &amp; Google Play review scraping — free, no signup.
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
// <link rel="icon" href="/favicon.ico?v=2"> in +html.tsx resolves. Rendered
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
