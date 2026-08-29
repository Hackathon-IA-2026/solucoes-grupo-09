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

/** Every page that must exist for the export to be considered complete. */
const REQUIRED = [
  "index.html",
  ...LOCALES.flatMap((locale) => [
    join(locale, "index.html"),
    join(locale, "privacy.html"),
    join(locale, "terms.html"),
  ]),
];

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
 * one: the gate, `/app`, the 404. The path is the source of truth here too —
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

let rewritten = 0;
for (const file of htmlFiles(DIST)) {
  const rel = relative(DIST, file);
  const tree = treeOf(rel);
  const lang = langOf(rel, tree);
  const before = readFileSync(file, "utf8");

  let after = before.replace(/<html([^>]*?)\slang="[^"]*"/, `<html$1 lang="${lang}"`);
  // Only the locale trees get a locale-specific manifest. The gate and /app
  // are not in one, and pointing them at a manifest whose `start_url` is a
  // language they did not choose would be a worse answer than the neutral
  // file the shell already links.
  if (tree) {
    after = after.replace(
      /(<link[^>]*rel="manifest"[^>]*href=")\/manifest\.webmanifest(")/,
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

console.log(
  `localize-export: ${REQUIRED.length} required pages present; rewrote ${rewritten} file(s).`,
);
