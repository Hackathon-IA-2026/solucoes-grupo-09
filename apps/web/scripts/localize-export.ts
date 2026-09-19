/**
 * Post-export pass over `dist/`: give every prerendered page the `lang` and
 * the PWA manifest of the locale its URL claims, and refuse to finish if the
 * locale tree the export was supposed to produce is not actually there.
 *
 * Run automatically by `bun run export` (and by the Dockerfile through it).
 *
 * ## Why this exists at all
 *
 * `src/app/+html.tsx` is a *single global* document shell. expo-router gives
 * it no access to the route being rendered, so `<html lang>` cannot vary per
 * page from React — which was harmless while the export was Portuguese-only
 * and becomes wrong for half the pages the moment `/en/…` is prerendered too.
 * `docs/specs/i18n.md` proposes exactly this rewrite and marks it UNVERIFIED.
 *
 * ## Why it is safe (the part the spec could not confirm)
 *
 * The worry with rewriting prerendered HTML is hydration: React comparing the
 * markup it finds against the markup it would have produced, and throwing the
 * tree away over the difference. That cannot happen here, because `<html>` is
 * not inside the hydrated tree. Expo's web entry
 * (`node_modules/expo/src/launch/AppRegistry.web.tsx`) calls
 * `hydrateRoot(rootTag, element)` where `rootTag` is the `#root` **div** — the
 * document element and its attributes are outside React's reconciler
 * entirely, which is also why `+html.tsx` renders only during static export
 * and never on the client. The same argument covers the `<link rel="manifest">`
 * in `<head>`.
 *
 * The `[locale]` layout additionally sets `document.documentElement.lang` from
 * the route param after mount, so the attribute is right even for a page
 * reached by client-side navigation, where no prerendered HTML was involved.
 *
 * ## The manifest
 *
 * A single manifest cannot carry two names, and two `<link rel="manifest">`
 * tags on one page is undefined behaviour. So the shell emits exactly one
 * link, always, and this script points it at the per-locale file — one link
 * per page, no dedupe question to answer.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const DIST = join(import.meta.dir, "..", "dist");

/** Kept in sync by hand with `src/i18n/locale.ts` — this script runs in plain
 * Node/Bun, outside the app's module graph and its `@/` alias. */
const LOCALES = ["pt", "en"] as const;
type Locale = (typeof LOCALES)[number];
const LANG_TAG: Record<Locale, string> = { pt: "pt-BR", en: "en" };
const DEFAULT_LOCALE: Locale = "pt";

/**
 * Every page that must exist for the export to be considered complete.
 *
 * `pitch.html` is here once, not once per locale, and that is not an omission:
 * `/pitch` frames a single PDF and deliberately sits outside the `[locale]`
 * tree (see `src/app/pitch.tsx`), so `generateStaticParams` never sees it and
 * `/pt/pitch` is a path that should not exist.
 */
const REQUIRED = [
  "index.html",
  "pitch.html",
  ...LOCALES.flatMap((locale) => [
    join(locale, "index.html"),
    join(locale, "privacy.html"),
    join(locale, "terms.html"),
  ]),
];

/**
 * Static assets that must survive the export, checked here for the reason
 * nothing else can check them: they are not in the module graph.
 *
 * The pitch deck is fetched by an `<iframe src>` at runtime, so a `public/`
 * file that stopped being copied would produce a page that renders a blank
 * rectangle — no bundler error, no missing import, no failing render. This is
 * the last point in the build where the difference is still visible.
 */
const REQUIRED_ASSETS = ["wattsteer-pitch.pdf"];

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...htmlFiles(full));
    } else if (entry.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Which locale tree a file sits in, or `null` for the pages that live outside
 * one: the loading screen at `/`, `/app`, the 404. The path is the source of truth here too —
 * this script never inspects content to guess a language.
 */
function treeOf(relPath: string): Locale | null {
  const first = relPath.split(sep)[0].replace(/\.html$/, "");
  return LOCALES.includes(first as Locale) ? (first as Locale) : null;
}

/** The BCP-47 tag a page's `<html>` should carry. */
function langOf(relPath: string, tree: Locale | null): string {
  // The global 404 is English-only — `+not-found.tsx` sits outside the locale
  // tree and is `noindex`, so it gets the tag its own text is written in
  // rather than the site default.
  if (relPath === "+not-found.html") {
    return LANG_TAG.en;
  }
  return LANG_TAG[tree ?? DEFAULT_LOCALE];
}

const missing = REQUIRED.filter((page) => {
  try {
    return !statSync(join(DIST, page)).isFile();
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  console.error(
    `localize-export: dist/ is missing ${missing.length} page(s) that generateStaticParams should have produced:\n  ${missing.join("\n  ")}`,
  );
  process.exit(1);
}

// Size as well as presence: a copy step that produced a zero-byte file would
// pass an `isFile()` check and still ship a blank frame.
const emptyAssets = REQUIRED_ASSETS.filter((asset) => {
  try {
    return statSync(join(DIST, asset)).size === 0;
  } catch {
    return true;
  }
});
if (emptyAssets.length > 0) {
  console.error(
    `localize-export: dist/ is missing ${emptyAssets.length} static asset(s) that public/ should have provided:\n  ${emptyAssets.join("\n  ")}`,
  );
  process.exit(1);
}

let rewritten = 0;
for (const file of htmlFiles(DIST)) {
  const rel = relative(DIST, file);
  const tree = treeOf(rel);
  const lang = langOf(rel, tree);
  const before = readFileSync(file, "utf8");

  let after = before.replace(/<html([^>]*?)\slang="[^"]*"/, `<html$1 lang="${lang}"`);
  // Only the locale trees get a locale-specific manifest. `/` and /app are
  // not in one, and pointing them at a manifest whose `start_url` is a
  // language they did not choose would be a worse answer than the neutral
  // file the shell already links.
  if (tree) {
    after = after.replace(
      /(<link[^>]*rel="manifest"[^>]*href="[^"]*)\/manifest\.webmanifest(")/,
      `$1/manifest.${tree}.webmanifest$2`,
    );
  }

  if (after !== before) {
    writeFileSync(file, after);
    rewritten += 1;
  }

  // A page whose `lang` did not end up correct is a silent SEO bug, so make
  // it a loud build failure instead.
  const applied = after.match(/<html[^>]*\slang="([^"]*)"/)?.[1];
  if (applied !== lang) {
    console.error(
      `localize-export: dist/${rel} has lang="${applied ?? "(none)"}", expected "${lang}"`,
    );
    process.exit(1);
  }
}

// Under a path prefix (EXPO_PUBLIC_BASE_PATH, see app.config.ts) the
// manifests' root-relative start_url, scope and icons would send an installed
// app to the host's root. The files in public/ stay as they are; the export's
// copies are rewritten.
const basePath = process.env.EXPO_PUBLIC_BASE_PATH ?? "";
const prefixed = (path: string) => (path.startsWith("/") ? `${basePath}${path}` : path);
if (basePath) {
  for (const name of readdirSync(DIST).filter((file) => file.endsWith(".webmanifest"))) {
    const file = join(DIST, name);
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.start_url = prefixed(manifest.start_url);
    manifest.scope = prefixed(manifest.scope);
    for (const icon of manifest.icons ?? []) {
      icon.src = prefixed(icon.src);
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

console.log(
  `localize-export: ${REQUIRED.length} required pages and ${REQUIRED_ASSETS.length} static asset(s) present; rewrote ${rewritten} file(s).`,
);
