/**
 * The landing page's scroll-target vocabulary, and the URL fragment that
 * names one.
 *
 * ## Why this is a module of its own, with no React in it
 *
 * Two reasons, the second of which is the one that forced it.
 *
 * 1. The ids are a **shared vocabulary**, not a detail of the component that
 *    happens to declare them: `copy.nav.links[].target` names them, the
 *    sections carry them, the hook that reads `location.hash` validates
 *    against them, and a reader pastes one into a chat window. One list.
 * 2. `test/landing-fragments.test.ts` has to be able to *run* the parser to
 *    show it rejects `#/etc/passwd` and `#deck-2` — a structural grep over
 *    the source would assert the shape of the code rather than its behaviour.
 *    `bun test` cannot parse React Native, so anything importing `Platform`
 *    is untestable here; this file is kept free of React and React Native for
 *    the same reason `i18n/locale.ts` and `lib/pitch.ts` are.
 *
 * `components/landing/section.tsx` re-exports `SectionId` so the components
 * still read it from where a reader of the page expects to find it.
 */

/**
 * Every named scroll target on the landing page, in the order they appear.
 *
 * `deck` is last and is *not* in `copy.nav.links`: the nav row already ends
 * with a link to `/pitch`, the real route, and two items reading "Pitch deck"
 * one scrolling and one navigating is a coin flip for the reader. It is a
 * section id all the same, so `/pt/#deck` is a link somebody can send.
 */
export const SECTION_IDS = [
  "forecast",
  "engines",
  "showcase",
  "provenance",
  "deck",
] as const;

/** Named scroll targets. The nav, the CTAs and the URL fragment address sections by these. */
export type SectionId = (typeof SECTION_IDS)[number];

export function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value);
}

/**
 * The section a URL fragment names, or `null` if it names nothing here.
 *
 * Validated against `SECTION_IDS` rather than trusted, because the input is a
 * URL somebody else wrote: whatever comes back is used as a key into a table
 * of measured offsets and as an argument to `scrollTo`, and an unchecked
 * string there would be a silent no-op at best. `#` with nothing after it,
 * and the empty hash a browser leaves behind after a back navigation, both
 * mean "no target" rather than "the first section".
 *
 * Takes the hash rather than reading `window`, so it is a pure function a
 * test can call.
 */
export function sectionFromHash(hash: string | null | undefined): SectionId | null {
  if (!hash) {
    return null;
  }
  // `decodeURIComponent` throws on a malformed escape (`#%`), which a hand-
  // edited address bar can produce; a thrown error here would take the whole
  // landing page down on load, so the raw value is the fallback and the
  // membership test below is what actually decides.
  const raw = hash.replace(/^#/, "");
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return isSectionId(decoded) ? decoded : null;
}

/** The `href` a nav item carries for a section. Relative, so it keeps the locale path. */
export function fragmentHref(id: SectionId): string {
  return `#${id}`;
}
