/**
 * Synthetic day-ahead programme files, in the shape ONS publishes them.
 *
 * Every value is a different number so a column read into the wrong slot shows
 * up (`optimization.test.ts`'s argument, applied here) — none of it is physical.
 * The headers are the real ones, read from the 2026-09-18 files.
 */

export const DAILY_HEADER =
  "din_programacaodia;num_patamar;cod_exibicaousina;nom_usina;tip_geracao;" +
  "nom_modalidadeoperacao;id_subsistema;nom_subsistema;id_estado;nom_estado;" +
  "val_geracaoprogramada;val_disponibilidade;val_ordemmerito;val_inflexibilidade;" +
  "val_uc;val_razaoeletrica;val_geracaoenergetica;val_gesubgsub;val_exportacao;" +
  "val_reposicaoexportacao;val_faltacombustivel";

export const PXP_HEADER =
  "dat_programacao;num_patamar;cod_usinapdp;nom_usinapdp;val_previsao;val_programado";

export const FLOW_HEADER =
  "din_programacaodia;num_patamar;nom_elementofluxocontrolado;dsc_elementofluxocontrolado;" +
  "tip_terminal;cod_submercado;val_carga";

export type Tip = "EÓLICA" | "SOLAR" | "HIDRÁULICA" | "TÉRMICA";

export interface FixturePlant {
  code: string;
  /** Left padded on the wire, as ONS pads it. */
  subsystem: "N" | "NE" | "S" | "SE";
  tip: Tip;
  /** Programmed MW by patamar, index 0 = patamar 1. */
  programmed: (patamar: number) => number;
  availability?: (patamar: number) => number | null;
  /** Thermal components, when the plant reports them. */
  thermal?: { inflexibility: number; unitCommitment: number; meritOrder?: number };
}

export const pad = (value: string, width: number): string => value.padEnd(width, " ");

/** One `programacao_diaria` file. Every plant carries all 48 patamares unless `skip` says not. */
export function dailyCsv(
  day: string,
  plants: readonly FixturePlant[],
  options: {
    skip?: (plant: string, patamar: number) => boolean;
    patamares?: number;
  } = {},
): string {
  const lines: string[] = [];
  const count = options.patamares ?? 48;
  for (let patamar = 1; patamar <= count; patamar += 1) {
    for (const plant of plants) {
      if (options.skip?.(plant.code, patamar)) {
        continue;
      }
      const availability = plant.availability ? plant.availability(patamar) : 0;
      const thermal = plant.thermal;
      lines.push(
        [
          day,
          patamar,
          plant.code,
          `USINA ${plant.code}`,
          plant.tip,
          "TIPO I",
          pad(plant.subsystem, 3),
          pad(`SUBSISTEMA ${plant.subsystem}`, 20),
          "XX",
          "ESTADO",
          plant.programmed(patamar).toFixed(2),
          availability === null ? "" : availability.toFixed(2),
          thermal ? (thermal.meritOrder ?? 0).toFixed(2) : "",
          thermal ? thermal.inflexibility.toFixed(2) : "",
          thermal ? thermal.unitCommitment.toFixed(2) : "",
          thermal ? "0.00" : "",
          thermal ? "0.00" : "",
          thermal ? "0.00" : "",
          thermal ? "0.00" : "",
          thermal ? "0.00" : "",
          thermal ? "0.00" : "",
        ].join(";"),
      );
    }
  }
  return `${DAILY_HEADER}\n${lines.join("\n")}\n`;
}

/** The four subsystems, each with a wind and a solar plant and a thermal one, all different. */
export function wholeFleet(): FixturePlant[] {
  const plants: FixturePlant[] = [];
  const subsystems = ["N", "NE", "S", "SE"] as const;
  for (const [index, subsystem] of subsystems.entries()) {
    const base = (index + 1) * 100;
    plants.push(
      {
        code: `W${subsystem}`,
        subsystem,
        tip: "EÓLICA",
        programmed: (p) => base + p + 0.5,
        availability: (p) => base + p + 0.25,
      },
      {
        code: `S${subsystem}`,
        subsystem,
        tip: "SOLAR",
        programmed: (p) => base * 2 + p + 0.75,
        availability: (p) => base * 2 + p + 0.125,
      },
      {
        code: `H${subsystem}`,
        subsystem,
        tip: "HIDRÁULICA",
        programmed: (p) => base * 3 + p,
        availability: (p) => base * 3 + p + 1,
      },
      {
        code: `T${subsystem}`,
        subsystem,
        tip: "TÉRMICA",
        programmed: (p) => base * 4 + p,
        availability: (p) => base * 4 + p + 2,
        thermal: { inflexibility: base + 7, unitCommitment: base + 9 },
      },
    );
  }
  return plants;
}

export interface FixtureEntity {
  code: string;
  name?: string;
  programmed: (patamar: number) => number;
  forecast?: (patamar: number) => number;
}

/** One `programacao_x_previsao` file. The day is written `YYYYMMDD`, as ONS writes it. */
export function pxpCsv(
  day: string,
  entities: readonly FixtureEntity[],
  options: { skip?: (code: string, patamar: number) => boolean } = {},
): string {
  const compact = day.replaceAll("-", "");
  const lines: string[] = [];
  for (let patamar = 1; patamar <= 48; patamar += 1) {
    for (const entity of entities) {
      if (options.skip?.(entity.code, patamar)) {
        continue;
      }
      const forecast = entity.forecast
        ? entity.forecast(patamar)
        : entity.programmed(patamar);
      lines.push(
        [
          compact,
          patamar,
          pad(entity.code, 12),
          pad(entity.name ?? `ENTIDADE ${entity.code}`, 30),
          forecast.toFixed(2),
          entity.programmed(patamar).toFixed(2),
        ].join(";"),
      );
    }
  }
  return `${PXP_HEADER}\n${lines.join("\n")}\n`;
}

export interface FixtureElement {
  name: string;
  terminal?: number;
  submarket: string;
  load: (patamar: number) => number;
}

/** One `programacao_fluxo_controlado` file. */
export function flowCsv(day: string, elements: readonly FixtureElement[]): string {
  const lines: string[] = [];
  for (let patamar = 1; patamar <= 48; patamar += 1) {
    for (const element of elements) {
      lines.push(
        [
          day,
          patamar,
          element.name,
          `Descrição de ${element.name}`,
          element.terminal ?? 1,
          pad(element.submarket, 3),
          element.load(patamar).toFixed(2),
        ].join(";"),
      );
    }
  }
  return `${FLOW_HEADER}\n${lines.join("\n")}\n`;
}
