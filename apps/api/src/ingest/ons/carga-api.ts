import { BadInputError, UpstreamError } from "../../errors.js";
import type { SubsystemCode } from "../normalise.js";

/**
 * Transport for the ONS carga REST API — the one source in scope that publishes
 * **no bulk files at all**.
 *
 * `carga-energia-verificada` and `carga-energia-programada` expose only a data
 * dictionary and this API; CKAN `package_show` returns zero CSV/Parquet/XLSX
 * resources for either slug. So there is nothing to `HEAD`, nothing to
 * fingerprint and nothing to download — which is exactly why this module exists
 * beside `bulk-resource.ts` rather than inside it. What the two share is the
 * versioned write (`versioned-write.ts`), not the acquisition path.
 *
 * Everything here defends a measured trap. In descending order of danger:
 *
 * 1. **`cod_areacarga=SE` returns HTTP 200 with `[]`.** The south-east is
 *    `SECO` on this API and `SE` everywhere else in ONS. The familiar code is
 *    not an error — it is a silent report that a quarter of the country has no
 *    load. The mapping lives here and nowhere else (`docs/domain-model.md`:
 *    "the API's dialect is a transport detail").
 * 2. **Exceeding the documented three-month range truncates silently.**
 *    Measured 2026-08-28: `dat_inicio=2026-01-01&dat_fim=2026-06-30` returns
 *    HTTP 200 with 4944 rows ending at `2026-04-13` — 103 days of a 181-day
 *    request, with no error and no marker. Chunking is therefore a correctness
 *    requirement, and `assertCoverage` is the belt to its braces.
 * 3. **Older responses are not valid JSON.** Ranges through 2019-02 contain
 *    `"val_cargammgd": ,`. A strict parser aborts the whole backfill on it, so
 *    the response is repaired before parsing rather than after failing.
 */

/** Base of the ONS carga API. Unauthenticated; no key, no headers required. */
export const CARGA_API_BASE = "https://apicarga.ons.org.br/prd";

/** The two series this API publishes. They are different shapes, not a flag. */
export type LoadSeries = "VERIFIED" | "PROGRAMMED";

/** Path each series is served from. */
export const SERIES_PATH: Record<LoadSeries, string> = {
  VERIFIED: "/cargaverificada",
  PROGRAMMED: "/cargaprogramada",
};

/**
 * First date each series covers, from the ONS spec summaries. A request before
 * this legitimately returns nothing, which is the only case where an empty
 * response is not a failure.
 */
export const SERIES_COVERAGE_START: Record<LoadSeries, string> = {
  VERIFIED: "2016-01-01",
  PROGRAMMED: "2021-03-05",
};

/**
 * The `cod_areacarga` domain — all 33 codes, verbatim from the embedded OpenAPI
 * enum. This is a **finer geography than any other ONS source in scope**: the
 * four subsystems decompose into 25 geoelectric areas plus four loss areas.
 *
 * `SECO` is the south-east/centre-west subsystem. `SE` is not a member and must
 * never be sent — see the module note.
 */
export const LOAD_AREA_CODES = [
  // Subsistemas.
  "SECO",
  "S",
  "NE",
  "N",
  // Áreas geoelétricas.
  "RJ",
  "SP",
  "MG",
  "ES",
  "MT",
  "MS",
  "DF",
  "GO",
  "AC",
  "RO",
  "PR",
  "SC",
  "RS",
  "BASE",
  "BAOE",
  "ALPE",
  "PBRN",
  "CE",
  "PI",
  "TON",
  "PA",
  "MA",
  "AP",
  "AM",
  "RR",
  // Perdas.
  "PESE",
  "PES",
  "PENE",
  "PEN",
] as const;

export type LoadAreaCode = (typeof LOAD_AREA_CODES)[number];

/** What a `cod_areacarga` denotes. The three groups are ONS's own headings. */
export type LoadAreaKind = "SUBSYSTEM" | "GEOELECTRIC" | "LOSSES";

const SUBSYSTEM_AREAS = new Set<string>(["SECO", "S", "NE", "N"]);
const LOSS_AREAS = new Set<string>(["PESE", "PES", "PENE", "PEN"]);
const AREA_CODES = new Set<string>(LOAD_AREA_CODES);

/** Which of ONS's three groups an area code belongs to. */
export function loadAreaKind(code: LoadAreaCode): LoadAreaKind {
  if (SUBSYSTEM_AREAS.has(code)) {
    return "SUBSYSTEM";
  }
  return LOSS_AREAS.has(code) ? "LOSSES" : "GEOELECTRIC";
}

/**
 * WattSteer's subsystem code → this API's dialect.
 *
 * The only place `SECO` is written in the codebase. Everything downstream of
 * the adapter speaks `SE`.
 */
export const AREA_CODE_FOR_SUBSYSTEM: Record<SubsystemCode, LoadAreaCode> = {
  SE: "SECO",
  S: "S",
  NE: "NE",
  N: "N",
};

/**
 * The reverse mapping, defined only for the four subsystem codes.
 *
 * A geoelectric or loss area is **not** given a subsystem: ONS publishes no
 * area→subsystem assignment anywhere in scope, and inventing one would be
 * exactly the kind of plausible-looking guess this layer exists to refuse.
 */
export function subsystemForArea(code: LoadAreaCode): SubsystemCode | null {
  switch (code) {
    case "SECO":
      return "SE";
    case "S":
      return "S";
    case "NE":
      return "NE";
    case "N":
      return "N";
    default:
      return null;
  }
}

/** Whether a raw `cod_areacarga` is in the published domain. */
export function isLoadAreaCode(value: string): value is LoadAreaCode {
  return AREA_CODES.has(value);
}

/**
 * Resolve a caller-supplied area code, rejecting `SE` by name.
 *
 * `SE` gets its own message because it is the mistake a reasonable engineer
 * makes: it is the code every other ONS dataset uses, and this API answers it
 * with HTTP 200 and an empty array.
 */
export function resolveAreaCode(value: string): LoadAreaCode {
  const code = value.trim().toUpperCase();
  if (code === "SE") {
    throw new BadInputError(
      "cod_areacarga 'SE' is not in the carga API's domain — it returns HTTP 200 " +
        "with an empty array. The south-east/centre-west subsystem is 'SECO'.",
    );
  }
  if (!isLoadAreaCode(code)) {
    throw new BadInputError(`Unknown cod_areacarga '${value}'`);
  }
  return code;
}

/** An inclusive `YYYY-MM-DD` range, the only shape this API accepts. */
export interface DateRange {
  /** `dat_inicio`, inclusive. */
  from: string;
  /** `dat_fim`, inclusive. */
  to: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Documented cap: "Limite de 3 meses por chamada", on both endpoints. */
export const MAX_RANGE_MONTHS = 3;

function assertDate(value: string): void {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new BadInputError(`Expected a YYYY-MM-DD date, got '${value}'`);
  }
}

const asDay = (value: string): number => Date.parse(`${value}T00:00:00Z`);
const asIsoDay = (epoch: number): string => new Date(epoch).toISOString().slice(0, 10);

/**
 * Split a range into calls the API will answer in full.
 *
 * Three months is the documented limit; the measured behaviour past it is a
 * silently truncated 200, so this is not an optimisation. Chunks are cut on the
 * calendar rather than on a fixed day count so that a chunk boundary is a
 * readable date in a run log, and the last chunk is clamped to `to`.
 */
export function chunkDateRange(range: DateRange): DateRange[] {
  assertDate(range.from);
  assertDate(range.to);
  if (asDay(range.to) < asDay(range.from)) {
    throw new BadInputError(`Range ends before it starts: ${range.from} → ${range.to}`);
  }

  const end = asDay(range.to);
  const chunks: DateRange[] = [];
  let cursor = asDay(range.from);

  while (cursor <= end) {
    const start = new Date(cursor);
    // Three calendar months on from the chunk start, minus a day, keeps every
    // chunk inside the documented limit however long those months are.
    const boundary = Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + MAX_RANGE_MONTHS,
      start.getUTCDate(),
    );
    const chunkEnd = Math.min(boundary - MS_PER_DAY, end);
    chunks.push({ from: asIsoDay(cursor), to: asIsoDay(chunkEnd) });
    cursor = chunkEnd + MS_PER_DAY;
  }
  return chunks;
}

/**
 * Repair the malformed JSON older ranges return, without touching anything else.
 *
 * The observed defect is a key with no value: `"val_cargammgd": ,`. It appears
 * in `/cargaverificada` responses through 2019-02 — and not uniformly, since
 * 2019-02-15 parses cleanly while 2019-02-01 does not — so it cannot be gated
 * on a date and has to be handled on every response.
 *
 * The repair is a scanner rather than a regex because a regex cannot tell a
 * `":"` inside a string literal from a real key/value separator, and a
 * `dsc_*`-style free-text field would eventually contain one. Only a **missing**
 * value is filled, and only with `null` — nothing is coerced to zero, because a
 * value ONS did not publish is not a value of nought.
 */
export function repairMissingJsonValues(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    out += char;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== ":") {
      continue;
    }

    let ahead = i + 1;
    while (ahead < text.length && /\s/.test(text.charAt(ahead))) {
      ahead += 1;
    }
    const next = text.charAt(ahead);
    if (next === "," || next === "}" || next === "]" || next === "") {
      out += "null";
    }
  }
  return out;
}

/**
 * Parse a carga API response, repairing the observed defect only if it has to.
 *
 * `repaired` is returned rather than logged: whether a payload was valid JSON
 * is a fact about that payload, it is recorded on the provenance row, and it is
 * how a backfill can report which ranges are affected without re-fetching them.
 *
 * Repairing lazily rather than eagerly is deliberate — a *new* kind of
 * malformation still surfaces as a thrown error rather than being quietly
 * absorbed by a repair pass that runs on everything.
 */
export function parseTolerantJson(text: string): {
  value: unknown;
  repaired: boolean;
} {
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch {
    return { value: JSON.parse(repairMissingJsonValues(text)), repaired: true };
  }
}

/** One row of either endpoint, before normalisation. Values may be null. */
export interface RawLoadRow {
  cod_areacarga?: unknown;
  din_atualizacao?: unknown;
  dat_referencia?: unknown;
  din_referenciautc?: unknown;
  [field: string]: unknown;
}

/** An empty response for a period that should have data. Never swallowed. */
export class EmptyLoadResponseError extends UpstreamError {
  constructor(message: string) {
    super(message);
    this.name = "EmptyLoadResponseError";
  }
}

/** A response that stopped short of the range asked for. */
export class TruncatedLoadResponseError extends UpstreamError {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedLoadResponseError";
  }
}

export interface LoadRequest {
  series: LoadSeries;
  areaCode: LoadAreaCode;
  range: DateRange;
  fetch?: typeof fetch;
  /** Base URL, overridable so a test can point at a local server. */
  baseUrl?: string;
  /**
   * Today, UTC — the boundary past which a missing tail is legitimate rather
   * than a truncation. Injected so the coverage assertion is deterministic.
   */
  now?: Date;
}

/** One answered call: its rows and the URL and instant they came from. */
export interface LoadResponse {
  rows: RawLoadRow[];
  url: string;
  fetchedAt: Date;
  /** The bytes as received, for the raw archive and the content digest. */
  body: string;
  /** Whether the response needed repairing before it would parse. */
  repaired: boolean;
  httpStatus: number;
}

/** Build the request URL. Exported so a test can assert `SECO` is what is sent. */
export function loadRequestUrl(
  series: LoadSeries,
  areaCode: LoadAreaCode,
  range: DateRange,
  baseUrl: string = CARGA_API_BASE,
): string {
  const url = new URL(`${baseUrl}${SERIES_PATH[series]}`);
  url.searchParams.set("dat_inicio", range.from);
  url.searchParams.set("dat_fim", range.to);
  url.searchParams.set("cod_areacarga", areaCode);
  return url.toString();
}

/**
 * Fetch one chunk and assert it actually answered the question asked.
 *
 * Both assertions exist because this API's failure mode is a 200. An empty
 * array for a covered period is treated as a failure, and a response whose last
 * `dat_referencia` falls short of `dat_fim` is treated as a truncation — the
 * measured behaviour when a range exceeds three months.
 */
export async function fetchLoadRange(request: LoadRequest): Promise<LoadResponse> {
  const fetchImpl = request.fetch ?? fetch;
  const url = loadRequestUrl(
    request.series,
    request.areaCode,
    request.range,
    request.baseUrl,
  );

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new UpstreamError(`GET ${url} failed: HTTP ${response.status}`);
  }
  const body = await response.text();
  const fetchedAt = new Date();

  const { value, repaired } = parseTolerantJson(body);
  if (!Array.isArray(value)) {
    throw new UpstreamError(`GET ${url} did not return a JSON array`);
  }
  const rows = value as RawLoadRow[];

  assertCoverage(request, rows, url);
  return { rows, url, fetchedAt, body, repaired, httpStatus: response.status };
}

/**
 * The two silence detectors, together because they answer the same question:
 * did this 200 contain the data it claimed to?
 */
export function assertCoverage(
  request: LoadRequest,
  rows: readonly RawLoadRow[],
  url: string,
): void {
  const coverageStart = SERIES_COVERAGE_START[request.series];
  const beforeCoverage = request.range.to < coverageStart;

  if (rows.length === 0) {
    if (beforeCoverage) {
      return;
    }
    throw new EmptyLoadResponseError(
      `GET ${url} returned HTTP 200 with an empty array for a period the series ` +
        `covers (from ${coverageStart}). This API answers an unknown ` +
        "cod_areacarga the same way, so an empty response is never data.",
    );
  }

  // Truncation always drops the tail, so the greatest `dat_referencia` is the
  // detector. A range reaching into today or the future is exempt: the series
  // legitimately stops at the last settled day.
  const today = (request.now ?? new Date()).toISOString().slice(0, 10);
  if (request.range.to >= today) {
    return;
  }

  let last = "";
  for (const row of rows) {
    const day = typeof row.dat_referencia === "string" ? row.dat_referencia : "";
    if (day > last) {
      last = day;
    }
  }
  if (last < request.range.to) {
    throw new TruncatedLoadResponseError(
      `GET ${url} returned HTTP 200 but stopped at ${last}, short of ${request.range.to}. ` +
        "The API truncates over-long ranges silently — measured at 103 days.",
    );
  }
}
