/**
 * The official documents the product answers to, by their publishers' URLs.
 *
 * Constants rather than copy for the reason `SOURCE_URL` in `site-footer.tsx`
 * is one: a URL is not a translation, and two locales linking two addresses
 * would be two claims about one norm. Each was opened on 2026-09-18 and read
 * back — the ANEEL page title, the Planalto text of art. 1º-B, the NT's §5.1.2
 * with categories I to IV, and the ONS listing of the procedures in force.
 *
 * Free of React imports, like `lib/pitch.ts`, so a test can read them.
 */

/** REN ANEEL 1.030/2022 — the resolution under which ONS classifies a cut. */
export const REN_1030_URL = "https://www2.aneel.gov.br/cedoc/ren20221030.html";

/** NT-ONS DOP 0022/2025 — §5.1.2 is the ordem de corte I–IV. */
export const NT_DOP_0022_URL =
  "https://www.ons.org.br/AcervoDigitalDocumentosEPublicacoes/NT-ONS%20DOP%200022.2025%20-%20Crit%C3%A9rios%20para%20Gest%C3%A3o%20de%20Excedentes%20Energ%C3%A9ticos.pdf";

/** Lei 15.269/2025 — art. 1º-B, the compensation window from 1 Sept 2023. */
export const LEI_15269_URL =
  "https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/lei/L15269.htm";

/** ONS's list of the Procedimentos de Rede in force. */
export const GRID_PROCEDURES_URL =
  "https://www.ons.org.br/paginas/sobre-o-ons/procedimentos-de-rede/vigentes";

/** Open-Meteo's licence and terms, which the weather inputs are used under. */
export const OPEN_METEO_LICENCE_URL = "https://open-meteo.com/en/licence";
