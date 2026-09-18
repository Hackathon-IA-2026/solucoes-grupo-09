/**
 * How anything asks to reach a named section, without knowing what it is.
 *
 * ## The seam this is
 *
 * A section used to be a place on a page, so "reach it" meant `scrollToSection`
 * and every caller could say so. Explicar is a sheet over the map now, and
 * Mitigar is still an accordion in the flow, so "reach it" is a question only
 * the screen showing it can answer. This module is where that question is
 * asked; the answer lives wherever the section does.
 *
 * ## Why it is not in `app-shell.tsx`
 *
 * It was, and that put a dependency edge from the voice subsystem to the layout
 * shell: `voice-provider.tsx` imported one function and dragged the app's whole
 * chrome — the header, the pills, the badge, `SectionBlock` — into its module
 * graph to get it. The voice agent has no opinion about layout and should not
 * have to load one.
 *
 * The interface is two functions and the implementation is a variable, which is
 * the shape worth having: a module is deep when what it hides is larger than
 * what it shows, and what this hides is "every screen's idea of where its
 * sections are".
 *
 * ## Single-subscriber, deliberately
 *
 * One screen is mounted at a time and a section belongs to exactly one of them.
 * A list of handlers would mean two screens could both answer, and the caller
 * would reach a section on a page nobody is looking at.
 */

/** Whoever currently decides what reaching a section means. */
let handler: ((id: string) => void) | null = null;

/** The fallback: a section that nobody claimed is a place on the page. */
let fallback: (id: string) => void = () => undefined;

/**
 * Install the default, once, from the module that owns scrolling.
 *
 * Injected rather than imported so this module depends on nothing: importing
 * `scrollToSection` from the shell would rebuild the edge this file exists to
 * cut, in the other direction.
 */
export function setSectionFallback(scroll: (id: string) => void): void {
  fallback = scroll;
}

/**
 * Claim the handler for the life of a screen. Returns the undo, so a screen
 * that unmounts does not leave a handler pointing into a dead tree.
 */
export function onSectionRequest(next: (id: string) => void): () => void {
  handler = next;
  return () => {
    if (handler === next) {
      handler = null;
    }
  };
}

/** Reach a section, however the screen showing it chooses to. */
export function requestSection(id: string): void {
  (handler ?? fallback)(id);
}
