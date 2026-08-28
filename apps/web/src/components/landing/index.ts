/**
 * The landing page's components. Everything here is landing-only and
 * fixture-driven; nothing reaches for the API.
 *
 * Two things in this directory are general primitives sitting in a private
 * folder because this ticket may not touch `packages/ui`, and both should be
 * promoted when the app screens want them:
 *
 * - `band.ts` / `band-figure.tsx` — the `Figure` sum type and the rail that
 *   draws a P10–P90 interval. The app screens have exactly the same problem
 *   and `RiskBar` does not solve it.
 * - `cta-link.tsx` — a `PillButton` that is a real anchor. `PillButton`
 *   should probably grow an `href` variant instead.
 */

export * from "./band";
export * from "./band-figure";
export * from "./cta-link";
export * from "./driver-bars";
export * from "./engines";
export * from "./fan-chart";
export * from "./fixtures";
export * from "./hero";
export * from "./landing-nav";
export * from "./mitigation-stack";
export * from "./provenance";
export * from "./replay-compare";
export * from "./section";
export * from "./showcase";
