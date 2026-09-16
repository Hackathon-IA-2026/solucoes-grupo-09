/**
 * What the screen underneath is currently about.
 *
 * The briefing is mounted once, beside the dock, for the reason the dock itself
 * is mounted there: a reader can ask for one from any of the four screens, and a
 * stage that lived on a single screen would answer only there. The first cut of
 * this feature made exactly that mistake — the agent was told "briefing opened"
 * on Explain and nothing opened.
 *
 * But the *contents* are the screen's: a briefing draws what the screen has
 * already read, never its own copy, so the four screens publish what they hold
 * and the one stage renders it. That is the whole purpose of this context — it
 * carries data downward from the screen to a component mounted above it, which
 * is the one direction props cannot go.
 *
 * A screen that publishes nothing gets a briefing that can still be composed —
 * `compose.ts` reads the voice context and will emit a single refusal scene,
 * which is the honest answer to "brief me" on a screen that has read nothing.
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type BriefingData, NO_BRIEFING_DATA } from "@/components/briefing/briefing-data";
import type { VoiceContextInput } from "@/lib/voice/context";

export interface BriefingSubject {
  /** Enough state for `compose.ts` to decide which scenes a briefing may have. */
  readonly context: VoiceContextInput | null;
  /** Enough data for those scenes to draw something. */
  readonly data: BriefingData;
  /**
   * Two scored figures from a screen that has solved a plan.
   *
   * The only route by which a `counterfactual` scene can exist: `compose.ts`
   * refuses to build one without it, so a briefing on a screen that has solved
   * nothing simply has no such scene.
   */
  readonly counterfactual: CounterfactualPair | undefined;
}

/** What the counterfactual scene is built from. Named so screens can spell it. */
export interface CounterfactualPair {
  readonly action: "battery" | "shiftable_load";
  readonly baselineMwh: number;
  readonly optimizedMwh: number;
}

const EMPTY: BriefingSubject = {
  context: null,
  data: NO_BRIEFING_DATA,
  counterfactual: undefined,
};

interface SubjectStore {
  readonly subject: BriefingSubject;
  readonly publish: (subject: BriefingSubject) => void;
}

const SubjectContext = createContext<SubjectStore>({
  subject: EMPTY,
  publish: () => {},
});

export function BriefingSubjectProvider({ children }: { children: ReactNode }) {
  const [subject, setSubject] = useState<BriefingSubject>(EMPTY);
  const value = useMemo(() => ({ subject, publish: setSubject }), [subject]);
  return <SubjectContext.Provider value={value}>{children}</SubjectContext.Provider>;
}

/** Read what the mounted screen is about. For the stage, which sits above it. */
export function useBriefingSubject(): BriefingSubject {
  return useContext(SubjectContext).subject;
}

/**
 * Publish this screen's subject.
 *
 * Called from a screen's render with a freshly-built object every time, so the
 * effect compares by *content* rather than identity — otherwise every render
 * would publish, set state on the provider, and re-render the whole subtree.
 */
export function usePublishBriefingSubject(subject: BriefingSubject): void {
  const { publish } = useContext(SubjectContext);
  const signature = subjectSignature(subject);
  /*
    The latest subject, held in a ref so the effect can publish it without
    depending on its identity.

    A screen builds this object fresh on every render, so an effect that
    depended on it would publish on every render, set state on the provider, and
    re-render the screen — a loop. The signature is the honest dependency: it
    changes exactly when something that could change a briefing changes.
  */
  const latest = useRef(subject);
  latest.current = subject;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the intended trigger and `latest.current` deliberately is not — depending on the ref's contents would publish on every render, set state on the provider, and re-render the screen that published
  useEffect(() => {
    publish(latest.current);
  }, [signature, publish]);
}

/**
 * What about a subject can change a briefing.
 *
 * Deliberately coarse: the statuses, the selection and whether each slice is
 * present. A briefing recomposes when the *shape* of what is available changes,
 * not when a megawatt-hour moves by a decimal — and a signature over the full
 * data would be a deep hash on every render of every app screen.
 */
function subjectSignature(subject: BriefingSubject): string {
  const { context, data, counterfactual } = subject;
  return [
    context?.screen ?? "-",
    context?.params.subsystem ?? "-",
    context?.params.date ?? "-",
    context?.network?.status ?? "-",
    context?.explain?.status ?? "-",
    data.paint === null ? "0" : "1",
    data.forecastHours === null ? "0" : "1",
    data.observedHours === null ? "0" : "1",
    data.drivers === null ? "0" : "1",
    data.reasons === null ? "0" : "1",
    data.dayEnergy === null ? "0" : "1",
    data.peakPower === null ? "0" : "1",
    data.comparison === null ? "0" : "1",
    counterfactual === undefined ? "0" : "1",
  ].join("|");
}
