import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  LOCALES,
  localePath,
} from "../src/i18n/locale";

/**
 * The entry experience: the loading screen at `/`, and the rule that a reader
 * who chose English keeps it.
 *
 * `/` used to be a language chooser. Deleting it moves a decision from the
 * reader to the code, and the code now has to be right about it in three
 * separate places — the pre-hydration script in `+html.tsx`, the route's own
 * effect, and every link that means "home". These tests are the ones that fail
 * when any of the three drifts back to "just send them to `/pt/`".
 *
 * They read source rather than render it: this suite has no DOM and no
 * renderer. What a *browser* does with the export is asserted in
 * `e2e/entry.spec.ts`, against the real `dist/`.
 */

const SRC = join(import.meta.dir, "..", "src");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf8");

const SHELL = read("app", "+html.tsx");
const SCREEN = read("app", "index.tsx");

/**
 * The two pieces of resolution logic, sliced out of the prose around them.
 *
 * Both files explain this ordering in comments *and* implement it, and an
 * `indexOf` over the whole file happily matches the explanation — which would
 * make the ordering assertions below pass on a file whose code does the
 * opposite of what its comment says. Slicing to the executable part is the
 * difference between checking the code and checking the commentary.
 */
const SCRIPT = SHELL.slice(SHELL.indexOf("(function(){try{"));
const EFFECT = SCREEN.slice(SCREEN.indexOf("const target ="));

describe("the loading screen at /", () => {
  test("says one sentence, in one locale, and lists no languages", () => {
    // The chooser's defining shape was a list: `LOCALES.map(…)` into a link
    // per locale, and both taglines side by side. Its absence is the change.
    expect(SCREEN).not.toContain("LOCALE_NAME");
    expect(SCREEN).not.toMatch(/LOCALES\.map/);
    // `pt.` / `en.` — reading a dictionary directly rather than through the
    // provider is how a screen renders two languages at once.
    expect(SCREEN).not.toMatch(/\b(pt|en)\.splash\./);
    expect(SCREEN).toContain("copy.splash.tagline");
  });

  test("the subtitle is real copy in both locales, not one sentence twice", () => {
    for (const dictionary of [pt, en]) {
      expect(dictionary.splash.tagline.length).toBeGreaterThan(20);
    }
    expect(pt.splash.tagline).not.toBe(en.splash.tagline);
    // The two sentences the brief names, verbatim. They are the only copy on
    // the screen, so a silent edit to either is worth failing over.
    expect(pt.splash.tagline).toBe(
      "Inteligência de curtailment para a rede elétrica brasileira.",
    );
    expect(en.splash.tagline).toBe("Curtailment intelligence for the Brazilian grid.");
  });

  test("it redirects on every platform, not only on native", () => {
    // The chooser's effect began `if (Platform.OS === "web") return;` — the
    // web redirect was the shell's job alone. That left client-side
    // navigation into `/` (an unknown locale, redirected by
    // `[locale]/_layout.tsx`) sitting on a screen with nothing to move it on,
    // because the shell's script only runs on a full document load.
    expect(SCREEN).toMatch(/router\.replace\(localePath\(target\)/);
    expect(SCREEN).not.toMatch(/if \(Platform\.OS === "web"\) \{\s*return;/);
  });

  test("it replaces rather than pushes", () => {
    // Pushed, it sits in the history stack: Back from `/pt/` lands here and
    // is bounced straight forward again, and the visitor cannot leave.
    expect(SCREEN).not.toMatch(/router\.push\(/);
  });

  test("the no-JS way out is one link, revealed by <noscript>", () => {
    // Not a chooser reintroduced by the back door: one link, to the default
    // locale the resolver would have picked anyway. Both roots still reach a
    // crawler through the hreflang set, which is why it can be one.
    expect(SCREEN).toContain("noscriptOnly");
    expect(SHELL).toContain("<noscript>");
    expect(SHELL).toContain("[data-noscript-only]{display:flex!important}");
    // `!important` is load-bearing: react-native-web writes the link's
    // `display:none` as a class, and an author `!important` is what outranks
    // both a class and an inline style.
    expect(SHELL).toMatch(/data-noscript-only[^}]*!important/);
  });

  test("it is noindex,follow and declares both locale roots", () => {
    expect(SCREEN).toMatch(/content="noindex,follow"/);
    expect(SCREEN).toContain("alternatesFor");
  });
});

describe("a chosen language persists", () => {
  test("the pre-hydration script reads the key the switch writes", () => {
    // The script is a string literal — outside the module graph, so nothing
    // else can check that it still names the same storage key. Derived from
    // `locale.ts` here rather than restated, so renaming the key breaks this
    // test rather than breaking persistence silently.
    expect(SHELL).toContain(`localStorage.getItem("${LOCALE_STORAGE_KEY}")`);
    expect(read("i18n", "index.tsx")).toContain("LOCALE_STORAGE_KEY");
  });

  test("a stored choice is the only thing that beats the default", () => {
    /*
      The rule was stored → browser languages → pt. It is now stored → pt, and
      the change was measured rather than preferred: the deployed build sent a
      default Chromium to `/en/` on a first visit, and the product is Brazilian.
      The browser's languages are no longer an input on either path.
    */
    expect(SCRIPT.indexOf("localStorage.getItem")).toBeGreaterThan(-1);
    expect(SCRIPT).not.toContain("navigator.languages");
    expect(SCRIPT).not.toContain("navigator.language");
  });

  test("it falls back to the default locale and to nothing else", () => {
    expect(SHELL).toContain(`?s:"${DEFAULT_LOCALE}"`);
  });

  test("the route's own effect applies the same rule", () => {
    // Same two steps, same order, or a client-side navigation into `/` and a
    // full load of `/` disagree about where the reader belongs.
    expect(EFFECT).toContain("readStoredLocale() ?? DEFAULT_LOCALE");
    expect(EFFECT).not.toContain("matchLocale(");
  });

  test("the language switch writes the choice on a link, not only on a toggle", () => {
    // Under the route-driven provider the switch is a `Link`; the navigation
    // is the Link's job and the write is the component's. Drop the `onPress`
    // and the switch still works — and the choice survives exactly until the
    // reader closes the tab.
    const source = read("components", "language-switch.tsx");
    expect(source).toContain("onPress={() => setLocale(option)}");
    expect((source.match(/setLocale\(option\)/g) ?? []).length).toBe(2);
  });

  test("and it does not overwrite the navigation it was cloned with", () => {
    // `Link asChild` injects its own `onPress` — the one that navigates. A
    // bare `onPress={onPress}` after the spread replaced it, and the switch
    // wrote the preference and then stayed on the page it was on. Both
    // handlers have to run.
    // Comment lines stripped: the file *explains* the defect, and the words
    // of the explanation are not the defect.
    const code = read("components", "language-switch.tsx")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/onPress=\{onPress\}/);
    expect(code).toContain("navigate?.(event)");
  });
});

/**
 * Files that may name bare `/` as a destination, and why.
 *
 * Everything else links to `localePath(locale)`. A wordmark pointing at `/`
 * is a round trip through the resolver, which is correct only while the
 * reader's stored choice survives — and is a silent reset to Portuguese the
 * moment it does not, which is the failure this whole change exists to remove.
 */
const MAY_LINK_TO_ROOT: ReadonlyMap<string, string> = new Map([
  [
    join("app", "+html.tsx"),
    "the pre-hydration script compares `location.pathname` against it; it links nowhere",
  ],
  [
    join("app", "[locale]", "_layout.tsx"),
    "an unknown locale has no locale to stay in, so it goes to the resolver by design",
  ],
  [join("app", "index.tsx"), "it *is* the screen at `/`"],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const ROUTED = [join(SRC, "app"), join(SRC, "components")].flatMap(sourceFiles);

describe("everything that means home honours the locale", () => {
  test("no screen links to bare /", () => {
    const ROOT_LINK = /(?:href=\{?"\/"\}?|(?:push|replace|navigate)\("\/"\))/;
    const offenders = ROUTED.map((file) => relative(SRC, file))
      .filter((rel) => !MAY_LINK_TO_ROOT.has(rel))
      .filter((rel) => ROOT_LINK.test(readFileSync(join(SRC, rel), "utf8")));
    expect(offenders).toEqual([]);
    // Non-vacuity: the pattern has to match the thing it forbids.
    expect(ROOT_LINK.test('<Link href="/" style={{}}>')).toBe(true);
    expect(ROOT_LINK.test('router.push("/")')).toBe(true);
    expect(ROOT_LINK.test("<Link href={localePath(locale) as never}>")).toBe(false);
  });

  test("the exemption list names only files that still exist and still do it", () => {
    // An exemption that has stopped being needed stops describing the tree.
    for (const [rel, why] of MAY_LINK_TO_ROOT) {
      expect([rel, statSync(join(SRC, rel)).isFile()]).toEqual([rel, true]);
      expect(why.length).toBeGreaterThan(20);
    }
  });

  test("the wordmark, the 404 and the app chrome route through localePath", () => {
    for (const rel of [
      join("components", "landing", "landing-nav.tsx"),
      join("components", "app", "app-shell.tsx"),
      join("app", "+not-found.tsx"),
    ]) {
      expect([
        rel,
        readFileSync(join(SRC, rel), "utf8").includes("localePath(locale)"),
      ]).toEqual([rel, true]);
    }
  });

  test("a link home pops back to the landing page rather than stacking one", () => {
    /*
      Measured on the exported build: `/pt/` → `/pitch` → the link home left
      *two* landing screens in the stack, the first still mounted. Two copies
      of that page means two elements for every section id, which is how the
      nav silently stopped scrolling (see `landing-fragments.test.ts`), and it
      leaves the stale copy's `Animated.loop`s and `popstate` listener running
      for the rest of the visit.

      `dismissTo` pops to the landing screen already in the stack instead.
      Every screen that offers a way home is listed, because the one that is
      forgotten is the one that reintroduces the duplicate.

      `landing-nav.tsx` is deliberately absent: its wordmark is on the landing
      page itself, so it targets the screen the reader is already on and
      pushes nothing.
    */
    // The `Link` screens carry the prop; the app chrome navigates
    // imperatively and carries the call. Matched against the *code* — each of
    // these files also explains itself in a comment, and an `includes` over
    // the whole file would be satisfied by the explanation alone.
    const HOME_LINKS: ReadonlyMap<string, string> = new Map([
      [join("app", "pitch.tsx"), "dismissTo={true}"],
      [join("app", "+not-found.tsx"), "dismissTo={true}"],
      [join("components", "legal-screen.tsx"), "dismissTo={true}"],
      [
        join("components", "app", "app-shell.tsx"),
        "router.dismissTo(localePath(locale) as never)",
      ],
    ]);
    const stripped = (rel: string) =>
      readFileSync(join(SRC, rel), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*|\{\/\*)/.test(line))
        .join("\n");
    for (const [rel, shape] of HOME_LINKS) {
      expect([rel, stripped(rel).includes(shape)]).toEqual([rel, true]);
    }
    // A push to the same place is the defect, by either spelling.
    const shell = stripped(join("components", "app", "app-shell.tsx"));
    expect(shell).not.toContain("router.push(localePath(locale) as never)");
  });

  test("a locale root keeps its trailing slash wherever it is linked", () => {
    // One canonical form, so the logo and the sitemap name the same URL.
    for (const locale of LOCALES) {
      expect(localePath(locale)).toBe(`/${locale}/`);
    }
  });
});

describe("the loading screen is actually seen, and defaults to pt", () => {
  const shell = readFileSync(join(import.meta.dir, "..", "src/app/+html.tsx"), "utf8");
  const route = readFileSync(join(import.meta.dir, "..", "src/app/index.tsx"), "utf8");

  /**
   * Measured against the deployed build before this change: navigating to `/`
   * painted the *landing page* at 0 ms. The redirect ran on the same tick as
   * the script, so the loading screen existed in the bundle and never on a
   * screen. The hold is what makes it a screen rather than a code path.
   */
  test("both redirect paths hold for the same minimum", () => {
    /*
      Read out of the route rather than restated here, and then required of the
      shell: the shell's redirect is a string inside the document and cannot
      import the constant, so the only thing keeping the two in step is this
      assertion. Importing the route instead would pull react-native into the
      test and hand back `undefined`.
    */
    const declared = route.match(/SPLASH_MIN_MS = (\d+)/);
    expect(declared).not.toBeNull();
    const ms = Number((declared as RegExpMatchArray)[1]);
    expect(ms).toBeGreaterThan(0);
    expect(route).toContain("setTimeout(");
    expect(shell).toContain(`},${ms});`);
  });

  /**
   * The product is Brazilian and the brief was explicit: pt-BR unless the
   * reader has chosen otherwise. Consulting `navigator.languages` sent an
   * English-locale browser to `/en/` on a first visit — measured, the deployed
   * build redirected to `/en/` from a default Chromium.
   */
  test("neither path consults the browser's languages", () => {
    expect(shell).not.toContain("navigator.languages");
    expect(shell).not.toContain("navigator.language");
    expect(route).not.toContain("navigator.language");
    expect(route).not.toContain("matchLocale");
  });

  test("a stored choice still wins over the default", () => {
    // Non-vacuity for the test above: dropping the browser step must not have
    // dropped persistence with it.
    expect(shell).toContain('localStorage.getItem("wattsteer.locale")');
    expect(route).toContain("readStoredLocale() ?? DEFAULT_LOCALE");
  });
});
