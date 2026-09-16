/**
 * How a region on the map responds to input — the interaction policy, apart
 * from the drawing.
 *
 * `SubsystemMap` was 490 lines in one component, and about a hundred of them
 * were this: a `handlers` object branching on platform, carrying the keyboard
 * ring, the hover pair, the focus pair and a style whose two lines each exist
 * because of a bug that shipped. None of it is about geometry, and none of it
 * could be tested — the arrow-key ring in particular was reachable only by
 * driving a browser.
 *
 * The three module-level pieces move with it, because they are the same
 * concern: the ring `ARROW_STEP` walks, the focus request `pendingArrowFocus`
 * parks between renders, and the scoped query `focusRegion` uses to honour it.
 * Splitting them from the handlers would have left a module that cannot answer
 * a question about itself.
 *
 * A `.ts` module: nothing here renders. That is also what keeps
 * `subsystem-map.tsx` exporting only components, which is what lets it be
 * hot-replaced.
 */

import { SUBSYSTEM_DISPLAY_ORDER, type SubsystemCode } from "@wattsteer/core";
import { motion, webTransition } from "@wattsteer/ui";
import type { MutableRefObject } from "react";
import { Platform } from "react-native";

/**
 * Which way each arrow key walks the four regions.
 *
 * One ring in `SUBSYSTEM_DISPLAY_ORDER` rather than a true 2-D adjacency graph.
 * Four regions do not form a grid — N is north-west, NE is north-east, SE/CO is
 * the middle and S is the tail — so a geographic mapping would have to answer
 * "what is east of S?" with something invented, and a reader pressing the same
 * key twice would arrive somewhere that depends on where they started. A ring
 * is learnable in two presses and is the order the rows beside the map are
 * already in, so the keyboard walks the list the eye walks.
 */
const ARROW_STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * The region an arrow key asked for, parked **outside the component** on
 * purpose, and held until focus actually lands there.
 *
 * Writing the selection goes through `router.setParams`, and measured in
 * chromium against the real export that **remounts this whole subtree, more
 * than once**: the four `<path>` elements are replaced, the element the reader
 * was on is detached, and the browser drops focus to the document. Component
 * state and refs go with it, and a single `focus()` — however well timed — is
 * undone by the next remount.
 *
 * So the request outlives the instance that made it (module scope) *and*
 * outlives one commit (cleared only once the element reports it holds focus).
 * It terminates on its own: the re-focus happens on every commit until one of
 * them sticks, and commits stop.
 *
 * Every simpler shape of this looked like it worked and did not. Focusing
 * inside the key handler focuses the node about to be detached; an effect on
 * component state never runs on the new instance; clearing the request on the
 * first attempt loses it to the remount that follows. All three land the first
 * arrow press and silently drop the second, after which the arrows do nothing
 * at all because focus is on `<body>`.
 *
 * Read back only when it names the region actually selected, so two maps
 * mounted at once cannot steal each other's focus.
 */
let pendingArrowFocus: SubsystemCode | null = null;

/**
 * Put focus on a region's path, and say whether it is already there.
 *
 * Scoped to the map's own container rather than found by document id: the
 * landing page has already been bitten once by a document-wide
 * `getElementById` resolving to a stale duplicate of a screen that was still
 * mounted (`e2e/landing-scroll.spec.ts` documents it), and a second Overview in
 * the stack would give this the same two candidates.
 */
function focusRegion(host: unknown, code: SubsystemCode): "held" | "asked" | "absent" {
  const container = host as { querySelector?: (s: string) => unknown } | null;
  const target = container?.querySelector?.(`[data-region="${code}"]`) as
    | { focus?: () => void; matches?: (selector: string) => boolean }
    | null
    | undefined;
  if (target === null || target === undefined) {
    return "absent";
  }
  if (target.matches?.(":focus") === true) {
    return "held";
  }
  target.focus?.();
  return "asked";
}

/**
 * The props a region `<Path>` needs to be interactive, for this platform.
 *
 * Returned as an opaque object because the two platforms hand back different
 * shapes — web gets DOM handlers and a style, native gets `onPress` and the
 * accessibility pair — and a union of the two would be a type nobody reads to
 * learn anything.
 */
export function regionHandlers({
  code,
  label,
  selected,
  reduced,
  onSelect,
  setActive,
  setFocusedCode,
}: {
  code: SubsystemCode;
  /** The announced name, which only the native branch attaches. */
  label: string;
  /** The current selection — the ring walks from here, not from `code`. */
  selected: SubsystemCode;
  reduced: boolean;
  onSelect: (code: SubsystemCode) => void;
  setActive: (code: SubsystemCode | null) => void;
  setFocusedCode: (code: SubsystemCode | null) => void;
}): object {
  return Platform.OS === "web"
    ? ({
        tabIndex: 0,
        // **No `role: "button"` here, and that is the whole of a bug
        // this shipped with.** `react-native-svg` renders `Path`
        // through react-native-web's `createElement`, and
        // `propsToAccessibilityComponent` turns `role`/
        // `accessibilityRole` into the *host element*: `"button"`
        // produced a real `<button>` carrying `d`, `fill` and
        // `stroke` as unknown attributes. A `<button>` draws no
        // geometry, so all four regions vanished and the map showed
        // only its non-interactive interior-borders path — dark grey,
        // uncolourable and unclickable.
        //
        // `aria-*` and `tabIndex` do not go through that mapping, so
        // the path stays a path and is still focusable and announced.
        // The role is carried by `aria-pressed` plus the label, which
        // is what a screen reader reads either way.
        "aria-label": label,
        "aria-pressed": code === selected,
        // Queried by `focusRegion`, and not an `id`: ids are
        // document-wide and this map can be mounted twice.
        "data-region": code,
        onClick: () => {
          // A pointer already shows where it is, so a click never
          // asks for focus to be moved — and clears a request an
          // arrow left unconsumed.
          pendingArrowFocus = null;
          onSelect(code);
        },
        onPress: () => onSelect(code),
        onKeyDown: (event: {
          key: string;
          preventDefault: () => void;
          currentTarget?: unknown;
        }) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(code);
            return;
          }
          const step = ARROW_STEP[event.key];
          if (step === undefined) {
            return;
          }
          // `preventDefault` because the map is inside the screen's
          // scroll view and an unhandled arrow scrolls the page —
          // which would move the map out from under the reader on the
          // very gesture meant to walk across it.
          event.preventDefault();
          const order = SUBSYSTEM_DISPLAY_ORDER;
          const at = order.indexOf(selected);
          const next = order[(at + step + order.length) % order.length];
          // Selection follows focus, deliberately. The panels below
          // are the answer to "which region", so a keyboard reader
          // who has to press Enter at every stop is being asked to
          // confirm a question they answered by arriving. It is also
          // what makes the arrow key *live*, which is the point.
          pendingArrowFocus = next;
          onSelect(next);
          setFocusedCode(next);
        },
        onMouseEnter: () => setActive(code),
        onMouseLeave: () => setActive(null),
        onFocus: () => {
          setFocusedCode(code);
          setActive(code);
        },
        onBlur: () => {
          setFocusedCode(null);
          setActive(null);
        },
        style: {
          cursor: "pointer",
          // **No `focusRing` here, and that is a bug this shipped
          // with.** `focusRing` sets a CSS `outline`, and a CSS
          // outline on an SVG element is drawn around its *bounding
          // box* — so focusing SE/CO painted a rectangle spanning
          // half the country, corner to corner, instead of tracing
          // the region. It was also keyed on `isActive`, which is
          // hover as well as focus, so a mouse produced it too.
          //
          // The indicator is the path's own `stroke` instead: it
          // follows the geometry, it is the same move selection
          // already makes, and there is nothing rectangular about it.
          // `outlineStyle: "none"` is explicit because the browser
          // draws its own ring on a focusable element otherwise, and
          // that ring is the same bounding box.
          outlineStyle: "none",
          ...(reduced ? {} : webTransition("fill-opacity", motion.fast)),
        },
      } as object)
    : ({
        onPress: () => onSelect(code),
        accessibilityRole: "button",
        accessibilityLabel: label,
      } as object);
}

/**
 * Hand the keyboard back the region it was walking to, once it exists.
 *
 * The component used to read and clear `pendingArrowFocus` itself, which meant
 * a module-level `let` was mutable from outside the module that owns it. It is
 * one call now, and the state is private: an arrow press parks a request here,
 * and the next commit that can honour it does.
 *
 * Called from an effect with **no dependency array**, deliberately, and that is
 * the whole of why the request is parked outside React at all: writing the
 * selection goes through `router.setParams`, which remounts this component, so
 * the instance that would "remember" the arrow press is not the instance that
 * gets to act on it.
 */
export function settleArrowFocus(
  selected: SubsystemCode,
  host: MutableRefObject<unknown>,
): void {
  if (pendingArrowFocus === selected && focusRegion(host.current, selected) === "held") {
    pendingArrowFocus = null;
  }
}
