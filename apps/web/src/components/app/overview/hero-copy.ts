/**
 * The hero's own strings.
 *
 * ADR-0006 puts copy in the two central dictionaries, and this deliberately
 * does not go there. The console is a mockup on its own branch, meant to be
 * read, argued with and then either adopted or deleted whole; scattering a
 * dozen keys through `copy.pt.ts` and `copy.en.ts` would make deleting it a
 * conflict in two files every other change also touches. If it is adopted,
 * these move into the dictionaries in the commit that adopts it.
 *
 * Both locales, for the same reason the rest of the product has both: a screen
 * that only speaks Portuguese cannot be shown to half the people who would
 * look at it.
 */

export interface HeroCopy {
  readonly title: string;
  readonly ledeForecast: string;
  readonly ledeObserved: string;
  readonly totalLabel: string;
  readonly totalNoteForecast: string;
  readonly totalNoteObserved: string;
  readonly regionsLabel: string;
  readonly profileLabel: string;
  readonly splitLabel: string;
  readonly peakLabel: string;
  readonly refusedTitle: string;
  readonly pickHint: string;
  readonly ofNational: string;
  readonly noBand: string;
  readonly nationalLabel: string;
  readonly windowForecast: string;
  readonly windowObserved: string;
}

export const HERO_COPY: Record<"pt" | "en", HeroCopy> = {
  pt: {
    title: "Console da rede",
    ledeForecast:
      "Os quatro subsistemas, com a previsão do dia seguinte em volta do mapa. Cada número é um intervalo P10–P50–P90, nunca um ponto.",
    ledeObserved:
      "Os quatro subsistemas, com o que o ONS já liquidou em volta do mapa. Tudo aqui é medido; nada é previsão.",
    totalLabel: "Energia cortada no dia",
    totalNoteForecast: "Banda conjunta do dia seguinte.",
    totalNoteObserved: "Dia liquidado, somando as horas publicadas.",
    regionsLabel: "Os quatro subsistemas",
    profileLabel: "Hora a hora",
    splitLabel: "Eólica e solar",
    peakLabel: "Maior hora",
    refusedTitle: "A rede não respondeu",
    pickHint: "Toque numa região do mapa para re-apontar tudo em volta.",
    ofNational: "do total nacional",
    noBand: "Uma liquidação é um número, não um intervalo.",
    nationalLabel: "Brasil",
    windowForecast: "Esperado no dia seguinte, por subsistema.",
    windowObserved: "Últimas 24 h liquidadas, por subsistema.",
  },
  en: {
    title: "Grid console",
    ledeForecast:
      "The four subsystems, with tomorrow's forecast around the map. Every figure is a P10–P50–P90 interval, never a point.",
    ledeObserved:
      "The four subsystems, with what ONS has already settled around the map. Everything here is measured; none of it is forecast.",
    totalLabel: "Curtailed energy, whole day",
    totalNoteForecast: "Tomorrow's joint band.",
    totalNoteObserved: "The settled day, summed over the published hours.",
    regionsLabel: "The four subsystems",
    profileLabel: "Hour by hour",
    splitLabel: "Wind and solar",
    peakLabel: "Largest hour",
    refusedTitle: "The grid did not answer",
    pickHint: "Tap a region on the map to re-point everything around it.",
    ofNational: "of the national total",
    noBand: "A settlement is a number, not an interval.",
    nationalLabel: "Brazil",
    windowForecast: "Expected tomorrow, per subsystem.",
    windowObserved: "The last settled 24 h, per subsystem.",
  },
};
