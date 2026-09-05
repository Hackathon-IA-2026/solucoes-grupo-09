/**
 * The model card fixture — what `GET /v1/model/card` returns, at fixture scale.
 *
 * **This is a separate module because it is a separate call.** The reliability
 * curve is a property of the *model*, not of a day: `docs/specs/api-surface.md`
 * §9 puts it on its own endpoint precisely so that a weekly-changing object
 * does not acquire a daily cache key, and so that tens of kilobytes of model
 * metadata do not ride on every Explain view. Until this file existed the
 * Explain screen read its curve out of the same fixture as its drivers, which
 * is exactly the shape the spec argues against — and the split had to happen in
 * the fixtures too, because a screen that reads one object cannot be wired to
 * two endpoints without first being wired to two objects.
 *
 * The fields are the route's, in the casing the generated client hands a screen.
 * A card is keyed by **lane** and never by subsystem or day: the same artifact
 * serves all four subsystems, so asking for a curve "for NE on the 29th" is
 * asking a question the card cannot answer.
 */

import type { ReliabilityPoint, VintageFidelity } from "./types";

/** The lane the prototype's numbers come from. */
export const FIXTURE_LANE = "dessem_free_v1__gate_late__thr5";

export interface ModelCardFixture {
  lane: string;
  /** The artifact this card describes — and the response's cache identity. */
  artifactId: string;
  reliability: ReliabilityPoint[];
  /** How many hours the reliability curve was computed over. */
  reliabilitySampleHours: number;
  /** The scored window, as civil dates — formatted by the reader's locale. */
  reliabilityWindowFrom: string;
  reliabilityWindowTo: string;
  reliabilityFidelity: VintageFidelity;
}

/**
 * Deliberately imperfect: the model is over-confident in the top bins, which is
 * what a real curve looks like and what the screen has to be able to show
 * without flinching.
 */
const RELIABILITY: ReliabilityPoint[] = [
  { binCentre: 0.05, observedFrequency: 0.03, hourCount: 4180 },
  { binCentre: 0.15, observedFrequency: 0.12, hourCount: 1960 },
  { binCentre: 0.25, observedFrequency: 0.27, hourCount: 1240 },
  { binCentre: 0.35, observedFrequency: 0.33, hourCount: 890 },
  { binCentre: 0.45, observedFrequency: 0.47, hourCount: 704 },
  { binCentre: 0.55, observedFrequency: 0.52, hourCount: 611 },
  { binCentre: 0.65, observedFrequency: 0.6, hourCount: 588 },
  { binCentre: 0.75, observedFrequency: 0.68, hourCount: 542 },
  { binCentre: 0.85, observedFrequency: 0.77, hourCount: 497 },
  { binCentre: 0.95, observedFrequency: 0.88, hourCount: 431 },
];

const CARD: ModelCardFixture = {
  lane: FIXTURE_LANE,
  artifactId: "2026-08-28T03:11:07Z",
  reliability: RELIABILITY,
  reliabilitySampleHours: RELIABILITY.reduce((acc, point) => acc + point.hourCount, 0),
  reliabilityWindowFrom: "2024-04-01",
  reliabilityWindowTo: "2026-08-27",
  // The whole reliability window predates ingestion go-live, so it is scored
  // against ONS's *current* restatement of the past.
  reliabilityFidelity: "revision_optimistic",
};

/** One lane's card. One argument, and it is the lane — never a day. */
export function buildModelCard(lane: string = FIXTURE_LANE): ModelCardFixture {
  return { ...CARD, lane };
}
