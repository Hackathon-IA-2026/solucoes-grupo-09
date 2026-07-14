import type { LegalTocSection } from "@zalytix/ui";
import { useRef, useState } from "react";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
} from "react-native";

/** A section is "active" once scrolled within this many px of its top. */
const ACTIVE_THRESHOLD = 100;
/** Treat the scroll as bottomed-out within this many px of the end. */
const BOTTOM_EPSILON = 20;

/**
 * Pure active-section resolver (extracted for unit tests): the last section
 * whose measured top is at or above `offsetY + threshold`, or the final
 * section once the scroll reaches the bottom (so the last item highlights
 * even when it's too short to cross the threshold).
 */
export function computeActiveSection(
  sections: ReadonlyArray<LegalTocSection>,
  positions: Readonly<Record<string, number>>,
  offsetY: number,
  atBottom: boolean,
  threshold: number = ACTIVE_THRESHOLD,
): string {
  if (sections.length === 0) {
    return "";
  }
  if (atBottom) {
    return sections[sections.length - 1].id;
  }
  let active = sections[0].id;
  for (const section of sections) {
    const y = positions[section.id];
    if (y !== undefined && offsetY >= y - threshold) {
      active = section.id;
    }
  }
  return active;
}

/**
 * Drives the legal-page table of contents: tracks the active section from
 * scroll offset, and scrolls to a section when a TOC item is pressed. Uses a
 * plain RN ScrollView (no reanimated) to keep the web bundle lean.
 */
export function useLegalToc(sections: ReadonlyArray<LegalTocSection>) {
  const [activeSection, setActiveSection] = useState(sections[0]?.id ?? "");
  const scrollRef = useRef<ScrollView>(null);
  const positions = useRef<Record<string, number>>({});

  // Plain functions — the React Compiler handles referential stability, so
  // manual useCallback would be redundant.
  const registerSection = (id: string) => (event: LayoutChangeEvent) => {
    positions.current[id] = event.nativeEvent.layout.y;
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const offsetY = contentOffset.y;
    const atBottom =
      offsetY + layoutMeasurement.height >= contentSize.height - BOTTOM_EPSILON;
    setActiveSection(
      computeActiveSection(sections, positions.current, offsetY, atBottom),
    );
  };

  const scrollToSection = (id: string) => {
    const y = positions.current[id];
    if (y !== undefined) {
      scrollRef.current?.scrollTo({ y, animated: true });
    }
  };

  return { activeSection, scrollRef, registerSection, onScroll, scrollToSection };
}
