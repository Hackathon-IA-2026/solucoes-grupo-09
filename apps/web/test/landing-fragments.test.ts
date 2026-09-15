import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";
import {
  fragmentHref,
  isSectionId,
  SECTION_IDS,
  sectionFromHash,
} from "../src/lib/section-fragment";

/**
 * Deep links into the landing page's sections.
 *
 * The defect this suite is built around is **silence**. Every part of this
 * feature fails without an error: a fragment naming a section that does not
 * exist scrolls nowhere, a section rendered without an `id` is unreachable by
 * a link that still looks right, and a nav item that lost its `href` still
 * scrolls perfectly when clicked — it just stops being a URL anybody can
 * send, which is the whole point of the change. None of those throw and none
 * are visible in a render, so they are asserted here.
 *
 * The parser is exercised for real — `src/lib/section-fragment.ts` is kept
 * free of React and React Native precisely so `bun test` can import it — and
 * the wiring around it is read off the source, in the shape
 * `test/landing-layout.test.ts` and `test/pitch.test.ts` already use.
 */

const WEB = join(import.meta.dir, "..");
const LANDING = join(WEB, "src", "components", "landing");
const HOME = join(WEB, "src", "app", "[locale]", "index.tsx");

const source = (path: string) => readFileSync(path, "utf8");

/** Source with comments blanked, so prose *about* a shape is not the shape. */
function code(path: string): string {
  return source(path)
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

describe("the fragment vocabulary is one vocabulary", () => {
  it("every nav target in both locales is a section id", () => {
    // The nav's targets are cast to `SectionId` at the call site, so a typo in
    // a dictionary is not a compile error — it is a nav item that scrolls
    // nowhere, in one language only.
    for (const [name, copy] of [
      ["pt", pt],
      ["en", en],
    ] as const) {
      for (const link of copy.nav.links) {
        expect([name, link.target, isSectionId(link.target)]).toEqual([
          name,
          link.target,
          true,
        ]);
      }
    }
  });

  it("the two locales name the same sections, in the same order", () => {
    // The row is the same row; only the labels are translated. Two locales
    // whose nav pointed at different sections would be two different pages.
    expect(pt.nav.links.map((link) => link.target)).toEqual(
      en.nav.links.map((link) => link.target),
    );
  });

  it("every section id is a section the landing page actually renders", () => {
    // An id in the list with no `<Section id="…">` behind it is a fragment
    // that resolves to nothing — and `/pt/#whatever` failing silently is the
    // defect. Read off the page rather than the components, because the page
    // is what decides which sections exist.
    const home = code(HOME);
    for (const id of SECTION_IDS) {
      expect([id, home.includes(`id="${id}"`)]).toEqual([id, true]);
    }
  });
});

describe("a fragment is parsed, not trusted", () => {
  it("it resolves the ids the nav uses", () => {
    expect(sectionFromHash("#engines")).toBe("engines");
    expect(sectionFromHash("#deck")).toBe("deck");
    // Browsers hand back the hash with its `#`; a caller passing the bare id
    // should get the same answer rather than a near-miss.
    expect(sectionFromHash("engines")).toBe("engines");
  });

  it("it rejects everything else rather than returning it", () => {
    // Whatever comes back is used as a key into the offsets table and as an
    // argument to `scrollTo`. An unvalidated string there is a silent no-op on
    // a good day; this is a URL somebody else wrote.
    expect(sectionFromHash("#enginesx")).toBeNull();
    expect(sectionFromHash("#/etc/passwd")).toBeNull();
    expect(sectionFromHash("#")).toBeNull();
    expect(sectionFromHash("")).toBeNull();
    expect(sectionFromHash(null)).toBeNull();
    expect(sectionFromHash(undefined)).toBeNull();
  });

  it("a malformed escape is a miss, not a thrown error", () => {
    // `decodeURIComponent("%")` throws `URIError`. This runs during the first
    // render of the landing page, so an uncaught throw there would be a blank
    // page for anyone who mangled the URL — worse than the link not working.
    expect(() => sectionFromHash("#%")).not.toThrow();
    expect(sectionFromHash("#%")).toBeNull();
    // And an escaped id still resolves, which is what the decode is for.
    expect(sectionFromHash("#%65ngines")).toBe("engines");
  });

  it("the href a nav item carries is the id the parser reads back", () => {
    // The round trip is the contract: whatever the nav writes into the URL has
    // to be something the cold-load path can recognise.
    for (const id of SECTION_IDS) {
      expect(sectionFromHash(fragmentHref(id))).toBe(id);
    }
  });
});

describe("the nav items are links, and the page acts on the fragment", () => {
  it("every in-page nav item carries an href", () => {
    // This is the change: they used to be `<div role="button">`, which scrolls
    // and leaves the address bar reading `/pt/` from top to bottom. Nothing
    // about the scrolling would break if the href went away again.
    const nav = code(join(LANDING, "landing-nav.tsx"));
    expect(nav).toContain("href={fragmentHref(link.target as SectionId)}");
    expect(nav).toContain('accessibilityRole="link"');
    expect(nav).not.toContain('accessibilityRole="button"');
  });

  it("a modified click is left to the browser", () => {
    // Cmd-clicking a section to open it in a new tab is the reason these are
    // links rather than buttons. Preventing the default unconditionally would
    // scroll this tab instead and quietly throw that away.
    const nav = code(join(LANDING, "landing-nav.tsx"));
    expect(nav).toMatch(/if \(!browserShouldHandle\(event\)\)/);
    for (const modifier of ["metaKey", "altKey", "ctrlKey", "shiftKey", "button"]) {
      expect([modifier, nav.includes(modifier)]).toEqual([modifier, true]);
    }
  });

  it("the deck link is still a route and not a fragment", () => {
    // `/pitch` is a real page outside the locale tree. Turning it into `#deck`
    // alongside the rest of the row would be a regression dressed as
    // consistency.
    const nav = code(join(LANDING, "landing-nav.tsx"));
    expect(nav).toContain("<NavLink label={copy.pitch.navLink} href={PITCH_PATH} />");
    expect(nav).toContain("<Link href={href as never} asChild={true}>");
  });

  it("each section renders a DOM id for its fragment to resolve to", () => {
    // `nativeID` is what react-native-web emits as `id`. Without it the href
    // is decoration: nothing for the browser to find, and nothing for a reader
    // with scripting off.
    const section = code(join(LANDING, "section.tsx"));
    expect(section).toContain("nativeID={id}");
  });

  it("the URL is written with pushState, not by assigning location.hash", () => {
    /*
      Assigning `location.hash` asks the browser to jump to the element — which
      now exists — in the same tick the smooth scroll starts in, so the page
      snaps to the destination and then animates from it to itself. `pushState`
      writes the URL and scrolls nothing.
    */
    const hook = code(join(LANDING, "use-section-fragment.ts"));
    expect(hook).toContain("window.history.pushState");
    // Assignment specifically, not the substring: the hook legitimately *reads*
    // `location.hash` and compares it, which `=` alone would also match.
    expect(hook).not.toMatch(/location\.hash\s*=[^=]/);
    // Non-vacuous: the pattern does find the shape it forbids, and does not
    // fire on the comparison the hook actually contains.
    expect('window.location.hash = "#deck";').toMatch(/location\.hash\s*=[^=]/);
    expect('window.location.hash === "#" + id').not.toMatch(/location\.hash\s*=[^=]/);
  });

  it("a fragment present at mount is held for layout, not spent on mount", () => {
    /*
      The static export ships the section's markup, but nothing has a position
      until the browser has laid the page out. An effect reading geometry on
      mount would measure a page that is still 0 px tall, so the target is
      pending state spent by layout, and the hash is read in a lazy initialiser
      rather than in an effect that is not guaranteed to run before the first
      layout does.
    */
    const hook = code(join(LANDING, "use-section-fragment.ts"));
    expect(hook).toMatch(
      /useState<SectionId \| null>\(\(\) =>[\s\S]{0,200}window\.location\.hash/,
    );
    expect(hook).toMatch(
      /const target = pending\.current;[\s\S]{0,120}apply\(target, false\)/,
    );
    // And back/forward is handled, which `pushState` makes this page's job.
    expect(hook).toContain('window.addEventListener("popstate"');
    expect(hook).toContain('window.removeEventListener("popstate"');
  });

  it("the cold-load target is re-applied, and the window that does it closes", () => {
    /*
      Measured on the exported build at 1440 × 900: applying the fragment once,
      on the target's first layout, landed `/en/#deck` 336 px past the section
      and `/pt/#engines` 51 px past it — the sections above the target were
      still reflowing after it had reported where it was. So it is re-applied
      on every layout while pending.

      Which makes the *release* the thing worth guarding: a page that keeps
      pulling a reader back to the section they have scrolled away from is a
      worse bug than the one this fixes. Both ends are asserted — the timer,
      and the reader's own first scroll.
    */
    const hook = code(join(LANDING, "use-section-fragment.ts"));
    expect(hook).toMatch(/const SETTLE_MS = \d+;/);
    expect(hook).toContain("setTimeout(release, SETTLE_MS)");
    for (const gesture of ["wheel", "touchstart", "keydown"]) {
      expect([gesture, hook.includes(`addEventListener("${gesture}", release`)]).toEqual([
        gesture,
        true,
      ]);
      expect([
        gesture,
        hook.includes(`removeEventListener("${gesture}", release)`),
      ]).toEqual([gesture, true]);
    }
    // And a click on the nav ends it too, or the settling would fight the
    // scroll the reader just asked for.
    expect(hook).toMatch(/pending\.current = null;\s*apply\(id, true\)/);
  });

  it("the position is read from the DOM, not from the last onLayout", () => {
    /*
      react-native-web's `onLayout` observes an element's *size*. A section
      pushed down the page by something above it growing has not changed size,
      so no layout event carries its new position and the last reported offset
      is stale — which is exactly how the 336 px above happened. The ids on the
      sections exist so the live position can be read instead; the offsets are
      still collected, because on native there is no DOM to read.
    */
    const hook = code(join(LANDING, "use-section-fragment.ts"));
    expect(hook).toContain("getBoundingClientRect()");
    expect(hook).toContain("offsets.current[id]");
  });

  it("the section is found inside the scroller, never document-wide", () => {
    /*
      A section id is not unique. Measured on the exported build: `/pt/` →
      `/pitch` → the link home mounted a second landing screen while the first
      was still in the tree, so `document.querySelectorAll("[id]")` returned
      forecast, engines, showcase, provenance and deck *twice*.
      `document.getElementById` answers with the first in tree order — the
      stale copy, whose rect read `{top: 0, height: 0}` — so every nav click
      computed an offset of 0, scrolled nowhere, and still wrote the fragment
      to the URL. The live section was at 4,075 px.

      `dismissTo` on the home links removes today's duplicate, but the lookup
      is what makes this correct however many copies exist, which is why it is
      asserted separately from them: any second route rendering these sections
      brings the duplicate ids straight back.

      The behavioural guard, with two elements really sharing an id, is
      `e2e/landing-scroll.spec.ts`. This one is here so the shape cannot be
      reverted without a test naming the reason.
    */
    const hook = code(join(LANDING, "use-section-fragment.ts"));
    // A regex rather than a string: the shape being asserted contains a
    // template placeholder, and a string literal holding one is a lint error
    // here (`noTemplateCurlyInString`) — correctly, since it looks like a
    // template that forgot its backticks.
    expect(hook).toMatch(/scroller\?\.querySelector\(`\[id="\$\{id\}"\]`\)/);
    expect(hook).not.toContain("document.getElementById");
    // Non-vacuity: the forbidden call is a string this assertion does find.
    expect("const target = document.getElementById(id);").toContain(
      "document.getElementById",
    );
  });
});
