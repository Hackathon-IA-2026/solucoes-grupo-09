/**
 * Screen 1 — Visão da rede (IDEA.md §42), read from the **real** gateway.
 *
 * Two halves, and today only one of them answers.
 *
 * **The forecast half** — the map, the four rows, the hourly fan and the two
 * day bands — is `GET /v1/grid/outlook` and `GET /v1/forecast/day-ahead`. Both
 * refuse in production right now, because no artifact is promoted on either
 * serving lane and nothing has been published; `use-network.ts` documents the
 * exact state and the exact codes. When they refuse, these panels are
 * **absent** — not skeletons, not zeroed bands, not a flat line at zero — and
 * the screen says which clause refused, from the typed code, in the reader's
 * locale.
 *
 * **The observed half** — the settled grid across the four subsystems, the
 * selected subsystem's settled day, and its recent episodes — is
 * `GET /v1/grid/now`, `GET /v1/curtailment/hours` and
 * `GET /v1/curtailment/episodes`. None of them loads a model and all three
 * answer today. `docs/specs/api-surface.md` names exactly these three as what
 * the Overview shows when no artifact is promoted, and that is what it shows.
 *
 * **The observed half renders in both states, and stays observed in both.** It
 * is not a fallback that disappears when a forecast arrives: what the grid has
 * actually been doing is worth the same on a day that is forecast as on a day
 * that is not. It is drawn by different components from the forecast half for
 * the reason `lib/network.ts` gives — the failure being designed against is a
 * settled total in the place a forecast band was, under the label the band had.
 *
 * **What changed, and why the screen is no longer mostly refusal text.** Every
 * panel here used to be one of two things: forecast, and therefore absent; or
 * observed, and therefore present but confined to the bottom of the page. So
 * the state production is actually in — nothing promoted, and it has been for
 * weeks — rendered as a sentence, a second sentence, and three panels below the
 * fold. The map, the four rows, the 24-hour profile, the wind/solar split and
 * the two day figures were all withheld together, and a reader arriving at the
 * product's main screen found almost nothing to look at.
 *
 * The question that fixes it is asked **per panel**: *what can this panel
 * answer from data that needs no model at all?* For five of the six, the answer
 * is a real one, and it is the settled series this screen was already reading:
 *
 * | Panel | With a model | With none |
 * | --- | --- | --- |
 * | Map | risk class per subsystem, three bins | settled MWh per subsystem, one ramp |
 * | Rows | expectation + P10–P90 + peak band | settled MWh, split, one share bar |
 * | 24 h | P10–P90 fan for tomorrow | the settled day's hourly bars |
 * | Wind/solar | a division of one modelled expectation | two published settlements |
 * | Day total | joint band from the ensemble | the settled day's sum |
 * | Peak | peak **power** band, in MW | the largest settled hour, in MWh |
 *
 * The sixth thing — a P10/P50/P90 interval — has no model-free answer and is
 * not given one. Where the forecast card draws a band, the observed card says
 * in words that there is no band and why. **An observation is never dressed as
 * a forecast**: the two never share a component, a colour, a badge or a
 * sentence, and `test/observed-overview.test.ts` and
 * `e2e/app-observed-overview.spec.ts` hold that from both ends.
 */

/*
  **Where the panels went.** This file was 1095 lines, which is the point at
  which a route stops being a route and becomes a library with a route at the
  top of it. The eight panel components moved to `components/app/overview/`
  unchanged — `forecast-panels.tsx`, `observed-panels.tsx`, `settled-panels.tsx`
  and the matched pair in `national-panel.tsx` — and what is left here is the
  decision this screen actually makes: which of the two stacks to draw, in which
  order, and what to say when the forecast half refuses.

  Every sentence above still holds; it is the screen's contract and it did not
  move. The files it now points at are where each half of it is implemented.
*/

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core";
import { usePalette } from "@wattsteer/ui";
import { router } from "expo-router";
import Head from "expo-router/head";
import type { ReactNode } from "react";
import { Text } from "react-native";
import ExplainScreen from "@/app/app/explain";
import MitigateScreen from "@/app/app/mitigate";
import { AppShell, ScreenTitle, scrollToSection } from "@/components/app/app-shell";
import { ForecastAbsent } from "@/components/app/forecast-absent";
import {
  ForecastPresence,
  ForecastStamp,
  HonestyNote,
  ObservedStamp,
} from "@/components/app/honesty";
import { ForecastPanels } from "@/components/app/overview/forecast-panels";
import { ObservedPanels } from "@/components/app/overview/observed-panels";
import { OverviewHero } from "@/components/app/overview/overview-hero";
import { SettledPanels } from "@/components/app/overview/settled-panels";
import { ReadingState, ThinkingOrb } from "@/components/app/thinking-orb";
import {
  gateProfileOf,
  sharedParams,
  useAppParams,
} from "@/components/app/use-app-params";
import { useNetwork } from "@/components/app/use-network";
import { useServing } from "@/components/app/use-serving";
import { usePublishBriefingSubject } from "@/components/briefing/briefing-subject";
import { useCopy, useFormat, useI18n } from "@/i18n";
import { fill } from "@/i18n/format";
import { type SubsystemCode, subsystemMeta } from "@/lib/fixtures";
import { forecastHours, forecastRow, observedRows, outlookRows } from "@/lib/network";

export default function GridOverviewScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const { locale } = useI18n();
  const serving = useServing();
  const params = useAppParams();
  const _meta = subsystemMeta(params.subsystem);
  const state = useNetwork({
    subsystem: params.subsystem,
    targetDate: params.date,
    gateProfile: gateProfileOf(params.run),
  });
  /**
   * The screen's own sentence, which is not the same sentence in both states.
   *
   * The forecast lede promises "every figure is a P10/P50/P90 interval, not a
   * point" — true of the forecast panels and flatly false of the observed ones,
   * which are points and nothing but. A lede that describes the other state's
   * panels is the first line a reader meets, so it is the first thing that has
   * to be right.
   */
  // Read before the early returns below, because a hook cannot sit behind one —
  // and because `reading` and `refused` are subjects too: a briefing asked in
  // either state should compose from what is true then.
  const settled =
    state.status === "reading" || state.status === "refused" ? null : state.observed;
  const published = state.status === "read" ? state.forecast : null;

  /*
    What a briefing may draw, published for the host mounted beside the dock.

    Read off this screen's own state and nothing else — the briefing never
    fetches, so a scene cannot show a forecast this screen does not have. In
    `observedOnly` the forecast slices are `null` and `compose.ts` omits their
    scenes; both fences hold the same line from two directions.
  */
  usePublishBriefingSubject({
    context: { locale, screen: "overview", params, serving, network: state },
    data: {
      paint:
        published === null
          ? {
              kind: "observed",
              rows:
                settled === null
                  ? []
                  : observedRows(settled.now.subsystems, SUBSYSTEM_DISPLAY_ORDER),
            }
          : { kind: "forecast", rows: outlookRows(published.outlook) },
      forecastHours: published === null ? null : forecastHours(published.forecast),
      thresholdMw: published === null ? null : published.forecast.thresholdMw,
      observedHours: settled === null ? null : settled.hours,
      // Explicar reads the diagnosis and the ONS reasons; this screen does not,
      // so it publishes neither. A briefing here has no `cause` scene to draw
      // and `compose.ts` will have emitted one only where the data exists.
      drivers: null,
      reasons: null,
      dayEnergy: published === null ? null : forecastRow(published.forecast).dailyEnergy,
      peakPower: published === null ? null : forecastRow(published.forecast).peakPower,
      comparison: null,
    },
    counterfactual: undefined,
  });

  const forecastPublished = state.status === "read";

  /**
   * **Selecting and navigating are two actions now, and they were one.**
   *
   * `select` used to be the `router.push` below. So a click on the map or on a
   * row carried two plausible meanings — "show me this region here" and "go
   * explain this region" — and silently did the second, which left the
   * four panels on this screen ("Perfil de 24 horas", "Eólica e solar",
   * "Energia cortada, dia inteiro", "Pico de potência horária") re-pointable
   * only from the menu at the top. A reader clicked a region expecting those
   * panels to change and was navigated away instead.
   *
   * `docs/plans/voice-copilot.md` §3.1 already drew exactly this line for the
   * agent: `highlight` "should **not** navigate. It should stay on Visão da
   * rede, light the NE on the map, and speak the band", while `explain` goes to
   * `/app/explain`. The mouse did not agree with the voice — the same gesture
   * the agent is forbidden to make by navigating was the only one a pointer
   * could make. **The two agree now**: a click selects, `highlight` emphasises,
   * and only a control with "Explicar" written on it navigates.
   *
   * Both are still defined once and handed to both affordances, which is what
   * the note that stood here was for, and still true.
   */
  const select = (subsystem: SubsystemCode) => params.setParams({ subsystem });

  /** The explicit affordance. Carries the rest of the selection with it. */
  /**
   * The explicit affordance — and it no longer leaves the page.
   *
   * It used to `router.push("/app/explain")`, which was right when Explicar was
   * a route and became wrong the moment it became a section of this one. A
   * control named "Explicar NORDESTE", on a page that already contains "Por que
   * NORDESTE?", was abandoning the page — losing the map, the selection framing
   * and the reader's scroll position — to show content that was six hundred
   * pixels below it. And it landed on a document where neither nav pill
   * reported itself as current.
   *
   * It carries the selection with it exactly as before; what changed is that
   * "carrying" is now `setParams` plus a scroll rather than a navigation. The
   * comment above about a click selecting rather than travelling applies to the
   * explicit control too — it should travel the length of the page, not off it.
   */
  const explain = (subsystem: SubsystemCode) => {
    params.setParams({ subsystem });
    scrollToSection("explain");
  };

  const frame = (right: ReactNode, body: ReactNode) => (
    <>
      <Head>
        <title>{copy.app.overview.metaTitle}</title>
        {/* `follow`, which the four `/app` screens and the 404 used to omit.
            The rest of the site already pairs the two — `/` and `/pitch` say
            `noindex,follow` — and for the same reason: the page should stay
            out of the index, but the links in its footer point at the landing
            page and the legal pages, and a bare `noindex` eventually has
            Google treat those links as `nofollow`. Nothing here is worth
            ranking; the pages it links to are. */}
        <meta name="robots" content="noindex,follow" />
      </Head>
      <AppShell fullWidth={true}>
        {/* No `title`: the selected pill in the bar above already says
            "Visão da rede", and this said it again in the largest type on the
            page. The lede carries the heading — see `ScreenTitle`. */}
        <ScreenTitle
          lede={
            forecastPublished
              ? fill(copy.app.overview.lede, { date: f.date(params.date) })
              : copy.app.overview.ledeObserved
          }
          right={right}
        />
        {body}

        {/*
          Three questions about one selection, on one page.

          Visão da rede, Explicar and Mitigar all read the same subsystem, the
          same day and the same run. They were three routes, so asking "why?"
          about the region just clicked meant leaving the page that framed the
          question — and the map already had to stop navigating for exactly this
          reason: a click selects, it does not travel. Máquina do tempo keeps
          its own route, because it is a different mode rather than a different
          view of this selection.

          Below `{body}` and therefore below the refusal branches too: Explicar
          reads its own gateway and Mitigar solves its own scenario, so neither
          has any business disappearing because the Overview's forecast half
          refused. Each section says what it knows.
        */}
        <ExplainScreen embedded />
        <MitigateScreen embedded />
      </AppShell>
    </>
  );

  if (state.status === "reading") {
    return frame(null, <ReadingState title={copy.app.overview.readingTitle} />);
  }

  if (state.status === "refused") {
    // Even the settled grid did not answer. There is nothing on this screen
    // that does not depend on it, so there is nothing to draw but the sentence
    // — and a sentence is what a reader can act on, where an empty page is not.
    return frame(
      null,
      <HonestyNote
        title={copy.app.overview.refusedTitle}
        tone="warning"
        points={[copy.error[state.code], copy.app.overview.refusedNote]}
      />,
    );
  }

  const observed = state.observed;
  const forecast = state.status === "read" ? state.forecast : null;

  return frame(
    /*
      The header slot says which of the two claims the screen is making, before
      a single number is reached. It used to be empty whenever no forecast was
      published, which left the most prominent line on the page saying nothing
      in the state the product is actually in.

      The orb beside it is the whole of what a re-read shows now. Selecting a
      region used to replace this entire page with `ReadingState`; the figures
      below are the previous region's until the new ones land, and this says so
      in the one place a reader is already looking.
    */
    /*
      Two children of `ScreenTitle`'s own row, not a `<View>` wrapping them.

      The wrapper was the cheaper-looking fix and it cost more: react-native-web
      defaults `flexShrink` to 0, so it sat at its content width, pushed the
      heading column past the page and clipped the map's legend 71px off the
      right edge at every width `no-horizontal-overflow.spec.ts` measures. The
      row it was sitting in already wraps and already gives width back. It
      needed one less box, not more flex properties on this one.
    */
    <>
      {forecast === null ? (
        <ObservedStamp
          latestSettledHour={observed.now.latestSettledHour}
          lagHours={observed.now.lagHours}
        />
      ) : (
        <ForecastStamp
          origin={forecast.forecast.forecastOrigin}
          thresholdMw={forecast.forecast.thresholdMw}
        />
      )}
      {state.refreshing ? (
        <ThinkingOrb size={18} accessibilityLabel={copy.app.overview.refreshingLabel} />
      ) : null}
    </>,
    // What the badges below need to know, stated once by the screen that knows
    // it. `forecast === null` is exactly "nothing here is a forecast", which is
    // when `Observado` distinguishes nothing and stands down.
    <ForecastPresence present={forecast !== null}>
      {/*
        **The hero, promoted out of the `/app/console` mockup.**

        The mockup asked whether a map-centred layout suits a product with four
        regions rather than four hundred cities. It does, so it is the top of
        this screen and the mockup route is gone.

        It is the *top*, not the whole. `heroElsewhere` tells the stacks below
        to skip the national figure, the map, the rows, the selection and the
        fan — which the hero draws — and to keep everything else they drew: the
        P10–P90 bands for the day and the peak, the technology split, the risk
        caveat, the settled section. A layout that reads better is not a reason
        to publish less, and this screen has lost panels twice to somebody
        promoting a nicer top and not checking the bottom.
      */}
      <OverviewHero
        observed={observed}
        forecast={forecast}
        params={params}
        onExplain={explain}
      />

      {/*
        Two stacks, never interleaved, and each one whole.

        `ForecastPanels` is everything a promoted model pays for, unchanged.
        `ObservedPanels` is the same six questions answered from settled data —
        map, rows, 24-hour profile, wind and solar, day total, largest hour —
        under the observed vocabulary throughout.

        In the `read` state the settled figures keep their own section at the
        bottom (`SettledPanels`), where they have always been: they are worth
        the same on a day that is forecast, and moving them next to the forecast
        panels is exactly the adjacency `lib/network.ts` refuses.
      */}
      {forecast === null ? (
        <ObservedPanels
          observed={observed}
          subsystem={params.subsystem}
          onSelect={select}
          onExplain={explain}
          heroElsewhere={true}
        />
      ) : (
        <>
          <ForecastPanels
            forecast={forecast}
            onSelect={select}
            onExplain={explain}
            heroElsewhere={true}
          />
          <SettledPanels
            observed={observed}
            subsystem={params.subsystem}
            onSelect={select}
          />
        </>
      )}

      {/*
        **The absence sits below the answers, not above them.**

        It used to open the screen: a reader arrived at "Sem previsão para este
        dia" and three paragraphs of explanation before reaching a single
        figure, on a page that was in fact full of real settled megawatt-hours.
        That ordering made the product look empty when it was not, and it made
        the most prominent line on the page a statement about what is missing.

        Nothing is withheld by moving it. Every panel above already carries
        `Observado` and says what it is; this says why the forecast half is not
        there, which is the right thing to read *after* seeing what is. The
        claim is the same claim — it has stopped being the headline.
      */}
      {state.status === "observedOnly" ? (
        <ForecastAbsent
          code={state.code}
          title={copy.app.overview.absentTitle}
          note={copy.app.overview.absentNote}
        />
      ) : null}

      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
        {/* The data's subject, not the selection's — same reason the panels
            above it changed. This sentence is about those panels. */}
        {fill(copy.app.overview.grainNote, {
          subsystem: subsystemMeta(observed.subsystem as SubsystemCode).onsDisplayName,
        })}
      </Text>
    </ForecastPresence>,
  );
}
