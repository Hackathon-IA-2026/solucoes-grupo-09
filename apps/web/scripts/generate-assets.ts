/**
 * Deterministic brand-asset generator: renders each asset as HTML in headless
 * Chromium and screenshots it at exact pixel size. Rerun after any brand
 * change: `bun scripts/generate-assets.ts` (from apps/web).
 *
 * Outputs:
 *   assets/images/icon.png                    1024  app icon (iOS + fallback)
 *   assets/images/favicon.png                   64  browser tab
 *   assets/images/splash-icon.png              512  splash logo (transparent)
 *   assets/images/android-icon-foreground.png 1024  adaptive fg (transparent)
 *   assets/images/android-icon-background.png 1024  adaptive bg (solid)
 *   assets/images/android-icon-monochrome.png 1024  adaptive mono (white)
 *   public/og.png                         1200×630  social share card
 */
import { join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(import.meta.dir, "..");
const EMERALD = "#047857";
const EMERALD_DEEP = "#065F46";
const PAPER = "#FAF8F4";
const INK = "#191C1F";
const INK_MUTED = "#4A5158";

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The wordmark glyph: rounded emerald square with a bold white N. */
function mark(size: number, options: { bg?: string; fg?: string; radius?: number } = {}) {
  const {
    bg = `linear-gradient(160deg, ${EMERALD} 0%, ${EMERALD_DEEP} 100%)`,
    fg = "#fff",
  } = options;
  const radius = options.radius ?? Math.round(size * 0.24);
  return `
    <div style="width:${size}px;height:${size}px;background:${bg};border-radius:${radius}px;
                display:flex;align-items:center;justify-content:center;">
      <span style="font-family:${FONT};font-weight:900;color:${fg};
                   font-size:${Math.round(size * 0.58)}px;line-height:1;
                   letter-spacing:${-size * 0.02}px;">N</span>
    </div>`;
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
    file: "assets/images/favicon.png",
    width: 64,
    height: 64,
    transparent: true,
    html: mark(64),
  },
  {
    file: "assets/images/splash-icon.png",
    width: 512,
    height: 512,
    transparent: true,
    // White-on-transparent logo; the splash background supplies the emerald.
    html: `<div style="width:512px;height:512px;display:flex;align-items:center;justify-content:center;">
             ${mark(340, { bg: "rgba(255,255,255,0.14)", fg: "#fff" })}
           </div>`,
  },
  {
    file: "assets/images/android-icon-foreground.png",
    width: 1024,
    height: 1024,
    transparent: true,
    // Adaptive-icon safe zone: keep the glyph inside the central ~66%.
    html: `<div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;">
             <span style="font-family:${FONT};font-weight:900;color:#fff;font-size:380px;line-height:1;">N</span>
           </div>`,
  },
  {
    file: "assets/images/android-icon-background.png",
    width: 1024,
    height: 1024,
    html: `<div style="width:1024px;height:1024px;background:linear-gradient(160deg, ${EMERALD} 0%, ${EMERALD_DEEP} 100%);"></div>`,
  },
  {
    file: "assets/images/android-icon-monochrome.png",
    width: 1024,
    height: 1024,
    transparent: true,
    html: `<div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;">
             <span style="font-family:${FONT};font-weight:900;color:#fff;font-size:380px;line-height:1;">N</span>
           </div>`,
  },
  {
    file: "public/og.png",
    width: 1200,
    height: 630,
    html: `
      <div style="width:1200px;height:630px;background:${PAPER};position:relative;overflow:hidden;
                  font-family:${FONT};box-sizing:border-box;padding:72px 80px;
                  display:flex;flex-direction:column;justify-content:space-between;">
        <div style="position:absolute;top:-220px;right:-160px;width:640px;height:640px;border-radius:50%;
                    background:radial-gradient(circle, rgba(4,120,87,0.14) 0%, rgba(4,120,87,0) 70%);"></div>
        <div style="display:flex;align-items:center;gap:20px;">
          ${mark(64)}
          <span style="font-size:34px;font-weight:800;color:${INK};letter-spacing:-0.5px;">Noviq</span>
        </div>
        <div>
          <div style="font-size:88px;line-height:1.04;font-weight:800;color:${INK};letter-spacing:-3px;">
            Every app review.<br/>One paste away.
          </div>
          <div style="margin-top:28px;font-size:30px;line-height:1.4;color:${INK_MUTED};max-width:860px;">
            Scrape App Store &amp; Google Play reviews to CSV — free, no signup.
          </div>
        </div>
        <div style="display:flex;gap:14px;">
          ${["App Store + Google Play", "CSV & JSON", "150+ storefronts"]
            .map(
              (
                chip,
              ) => `<span style="border:2px solid #E5E1D8;border-radius:999px;background:#fff;
                           padding:12px 26px;font-size:24px;font-weight:600;color:${INK_MUTED};">${chip}</span>`,
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
    `<!doctype html><html><body style="margin:0;${asset.transparent ? "background:transparent;" : ""}">${asset.html}</body></html>`,
  );
  await page.screenshot({
    path: join(ROOT, asset.file),
    omitBackground: asset.transparent ?? false,
    clip: { x: 0, y: 0, width: asset.width, height: asset.height },
  });
  console.log(`✓ ${asset.file} (${asset.width}×${asset.height})`);
}
await browser.close();
