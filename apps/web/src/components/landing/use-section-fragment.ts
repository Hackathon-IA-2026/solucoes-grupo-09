import { useReducedMotion } from "@wattsteer/ui";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Platform, type ScrollView } from "react-native";
import { type SectionId, sectionFromHash } from "@/lib/section-fragment";

/**
 * Deep links into the landing page's sections.
 *
 * The nav used to scroll and nothing else, so a reader who wanted to send
 * somebody "the bit about how it works" had no URL to send: every section of
 * this page was addressed by the same `/pt/`. This hook is the missing half —
 * the nav writes a fragment, and a URL arriving with one lands in the right
 * place.
 *
 * ## Why `history.pushState` and not `location.hash = …`
 *
 * Assigning `location.hash` asks the *browser* to scroll to the element with
 * that id, which is an instant jump — and the sections carry real ids now, so
 * it would land. That jump happens in the same tick the smooth scroll starts
 * in, so the page snaps to the destination and then animates from it to
 * itself. `pushState` writes the URL and scrolls nothing, which leaves the
 * animation as the only thing moving. It also means the history entry is ours,
 * so `popstate` below is the whole of the back/forward story.
 *
 * ## Why a *pending* target rather than "scroll on mount"
 *
 * This is a static export, so the section's markup is in the HTML the server
 * sends — but the geometry is not. Nothing has a position until the browser
 * has laid the page out, and on a cold load of `/pt/#deck` an effect that ran
 * on mount would measure a page that is still 0 px tall. So the fragment read
 * at mount is held as a *pending* target and spent by layout, not by mount.
 *
 * ## Why it is re-applied, and why that window is bounded
 *
 * Spending it on the target's *first* layout is not enough, and this is the
 * one part of the file that was measured rather than reasoned. On the exported
 * build, a cold load of `/en/#deck` at 1440 × 900 landed 336 px past the
 * section and `/pt/#engines` 51 px past it: the sections above the target were
 * still reflowing after it had first reported where it was, so the number it
 * reported was already wrong by the time the scroll took effect.
 *
 * Two changes together fix that. The position is read from the DOM at the
 * moment of the scroll rather than from the last `onLayout` — which is what
 * the ids on the sections buy, and which react-native-web's `onLayout` cannot
 * give, because it observes an element's *size* and a section pushed down the
 * page has not changed size. And the target is re-applied on every layout that
 * arrives until the page settles, rather than once.
 *
 * "Until it settles" is bounded two ways, because a landing page that keeps
 * yanking a reader back to a section they have scrolled away from is worse
 * than one that lands 300 px off: `SETTLE_MS` after mount, and immediately on
 * the first scroll the reader makes themselves.
 *
 * ## Native
 *
 * `window`, `history` and `document` are web-only, so everything touching them
 * is behind a `Platform.OS === "web"` guard and the hook degrades to exactly
 * the measured-offset scrolling the nav had before — which is why the offsets
 * are still collected. It is also why the scrolling is not simply handed to
 * the browser's anchor handling: that would only work on one of the two
 * platforms.
 */
export interface SectionFragment {
  /** Feed a section's measured `y` (within the scroll content) back in. */
  onSectionLayout: (id: SectionId, y: number) => void;
  /** Scroll to a section and put its fragment on the URL. */
  goTo: (id: SectionId) => void;
}

/**
 * A little air above the section that was scrolled to, so its heading does not
 * sit flush against the top edge. Carried over from the nav's original scroll.
 */
const NUDGE = 16;

/**
 * How long after mount a fragment from the URL keeps re-aligning itself.
 *
 * Long enough to cover the reflow measured above, which is done inside the
 * first couple of frames, and short enough that it is over before a reader has
 * finished reading the section they were sent to. A scroll of the reader's own
 * ends it sooner.
 */
const SETTLE_MS = 800;

/** react-native-web's `ScrollView` hands out its DOM node; React Native's types do not say so. */
interface Scrollable {
  getScrollableNode?: () => unknown;
}

export function useSectionFragment(
  scrollRef: RefObject<ScrollView | null>,
): SectionFragment {
  const offsets = useRef<Partial<Record<SectionId, number>>>({});
  const reducedMotion = useReducedMotion();

  // Read once, at mount, with a lazy initialiser rather than in an effect: the
  // value has to be in hand before the first layout arrives, and an effect is
  // not guaranteed to run before one does. It renders nothing, so there is no
  // hydration mismatch to have — during the static export there is no `window`
  // and this is `null`.
  const [initialTarget] = useState<SectionId | null>(() =>
    Platform.OS === "web" && typeof window !== "undefined"
      ? sectionFromHash(window.location.hash)
      : null,
  );
  const pending = useRef<SectionId | null>(initialTarget);

  /** The scrolling DOM element, on web. `null` everywhere else. */
  const scrollerNode = useCallback((): HTMLElement | null => {
    if (Platform.OS !== "web") {
      return null;
    }
    const node = (scrollRef.current as Scrollable | null)?.getScrollableNode?.();
    return node instanceof HTMLElement ? node : null;
  }, [scrollRef]);

  /**
   * A section's current y inside the scroll content, read from the DOM.
   *
   * `null` when there is no DOM to read — native, and the static export's own
   * render — in which case the caller falls back to the last reported
   * `onLayout`. Both rects rather than `offsetTop`, so this stays correct if
   * the scroller ever stops being the page's first element or a section gains
   * an offset parent between itself and the content container.
   *
   * ## Why the lookup is scoped to this scroller, not `document.getElementById`
   *
   * Because an id on this page is **not** unique, and was being trusted to be.
   * Measured on the exported build: load `/pt/`, open the deck at `/pitch`,
   * then follow the link home. The landing screen is mounted a second time
   * while the first copy is still in the tree, so the document holds two
   * elements for every section id — `document.querySelectorAll("[id]")`
   * returned `forecast, engines, showcase, provenance, deck` twice over.
   * `getElementById` answers with the *first* in tree order, which is the
   * stale copy: its container is not laid out, so its rect read
   * `{top: 0, height: 0}` and every nav click computed an offset of 0 and
   * scrolled nowhere while still writing the fragment to the URL. The live
   * section was at 4,075 px.
   *
   * Scoping the query to the scroller this hook was handed makes the answer
   * right by construction — a copy of the page somewhere else in the document
   * cannot be inside *this* scroll container. That matters beyond the
   * navigation that produced it: any second route rendering these sections
   * brings the duplicate ids back.
   *
   * `[id="…"]` rather than `#…`: it needs no escaping rules of its own, and
   * `id` is one of `SECTION_IDS`, which is a closed vocabulary the fragment
   * parser validates against — never a string off the URL.
   */
  const domOffset = useCallback(
    (id: SectionId): number | null => {
      const scroller = scrollerNode();
      const found = scroller?.querySelector(`[id="${id}"]`) ?? null;
      const target = found instanceof HTMLElement ? found : null;
      if (scroller === null || target === null) {
        return null;
      }
      return (
        scroller.scrollTop +
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top
      );
    },
    [scrollerNode],
  );

  /** Scroll to a section if it can be located; report whether it could. */
  const apply = useCallback(
    (id: SectionId, animated: boolean): boolean => {
      const y = domOffset(id) ?? offsets.current[id];
      if (y === undefined || y === null) {
        return false;
      }
      // React Native's `scrollTo`, on both platforms, and deliberately not the
      // DOM's on the node underneath. react-native-web *overwrites*
      // `scrollTo` on the scrollable element with its own `{x, y, animated}`
      // version (`_setScrollNodeRef` in its `ScrollView`), so a DOM-shaped
      // `scrollTo({ top, behavior })` there reads `y` as `undefined`, scrolls
      // to 0, and reports nothing wrong. Measured: it silently sent every
      // fragment to the top of the page. Only the *measurement* above is
      // web-specific; the move is the same call it always was.
      scrollRef.current?.scrollTo({
        y: Math.max(0, y - NUDGE),
        animated: animated && !reducedMotion,
      });
      return true;
    },
    [domOffset, reducedMotion, scrollRef],
  );

  const onSectionLayout = useCallback(
    (id: SectionId, y: number) => {
      offsets.current[id] = y;
      // Any section's layout is a reason to re-check the pending one: the
      // thing that moves the target is usually a section *above* it changing
      // height, and that is the event which reports it.
      const target = pending.current;
      if (target !== null) {
        apply(target, false);
      }
    },
    [apply],
  );

  // The two ends of the settle window. Both only matter when a fragment
  // arrived with the URL, so neither runs on an ordinary visit.
  useEffect(() => {
    if (pending.current === null) {
      return;
    }
    const release = (): void => {
      pending.current = null;
    };
    const timer = setTimeout(release, SETTLE_MS);
    if (Platform.OS !== "web" || typeof window === "undefined") {
      return () => clearTimeout(timer);
    }
    // A scroll the reader started outranks the fragment immediately: being
    // pulled back to a section you have deliberately left is worse than
    // landing a little short of it.
    const options = { passive: true, once: true } as const;
    window.addEventListener("wheel", release, options);
    window.addEventListener("touchstart", release, options);
    window.addEventListener("keydown", release, options);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchstart", release);
      window.removeEventListener("keydown", release);
    };
  }, []);

  const goTo = useCallback(
    (id: SectionId) => {
      // A deliberate move is the reader's own, so it ends any settling.
      pending.current = null;
      apply(id, true);
      if (Platform.OS !== "web" || typeof window === "undefined") {
        return;
      }
      // The same hash again would push a second entry that Back appears to
      // ignore — the reader presses it, the URL changes to the identical
      // string, and the page does not move.
      if (window.location.hash === `#${id}`) {
        return;
      }
      window.history.pushState(null, "", `#${id}`);
    },
    [apply],
  );

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") {
      return;
    }
    const onPopState = (): void => {
      const target = sectionFromHash(window.location.hash);
      if (target === null) {
        // Back out of the first fragment lands on the bare page, which is the
        // very top — above the hero, where the nav is — and not on `#forecast`,
        // whose section starts 65 px below it. Animated, because unlike a cold
        // load there is a position to animate from.
        scrollRef.current?.scrollTo({ y: 0, animated: !reducedMotion });
        return;
      }
      if (!apply(target, true)) {
        pending.current = target;
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [apply, reducedMotion, scrollRef]);

  return { onSectionLayout, goTo };
}
