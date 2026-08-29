import { UpstreamError } from "../../errors.js";
import {
  type CatalogueResource,
  type ResourceFormat,
  readResources,
} from "../ons/catalogue.js";

/**
 * The ANEEL CKAN catalogue.
 *
 * A second CKAN, not a second copy of the first: `readResources`,
 * `fingerprintFromHeaders` and `headResource` are payload- and header-shaped
 * rather than ONS-shaped, so they are reused verbatim. What genuinely differs
 * is the base URL and — the part that matters — **which resource of the package
 * is the right one**, because ANEEL publishes two files with an identical
 * 23-column header and picking the wrong one is a silent data error rather than
 * a failure.
 *
 * Attribution, carried here because this is the module that names the source:
 * contains information from **ANEEL SIGA**
 * (<https://dadosabertos.aneel.gov.br/dataset/siga-sistema-de-informacoes-de-geracao-da-aneel>),
 * made available under the **Open Database License (ODbL) 1.0**. See
 * `plant_geo` in `src/database/schema.ts` for what that obliges.
 */

/** Base of the ANEEL CKAN action API. */
export const ANEEL_CKAN_BASE = "https://dadosabertos.aneel.gov.br/api/3/action";

/** CKAN package id for SIGA. */
export const SIGA_DATASET_SLUG = "siga-sistema-de-informacoes-de-geracao-da-aneel";

/**
 * The daily resource's filename suffix.
 *
 * ANEEL ships `siga-empreendimentos-geracao.csv` (monthly) and
 * `siga-empreendimentos-geracao-diario.csv` (daily) with the **same header**,
 * so nothing downstream can tell them apart. The monthly cut is what leaves a
 * newly-operating plant sitting at `Construção` while ONS is already curtailing
 * it — twelve plants on the day the research was measured. Matched on the
 * URL rather than on the CKAN `name`, which is free text ANEEL may restyle.
 */
const DAILY_SUFFIX = "-diario.csv";

/** Fetch and decode `package_show` for an ANEEL dataset. */
export async function fetchAneelPackage(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogueResource[]> {
  const response = await fetchImpl(
    `${ANEEL_CKAN_BASE}/package_show?id=${encodeURIComponent(slug)}`,
  );
  if (!response.ok) {
    throw new UpstreamError(
      `ANEEL CKAN package_show ${slug} failed: HTTP ${response.status}`,
    );
  }
  return readResources(await response.json());
}

/**
 * Pick the **daily** SIGA extract, and refuse to substitute the monthly one.
 *
 * There is no fallback on purpose. A missing daily resource means ANEEL changed
 * the package, and silently ingesting the monthly cut instead would restore
 * exactly the lag this selector exists to avoid — three days of a plant being
 * curtailed at a registered capacity of zero, with nothing in the run summary
 * to show for it.
 */
export function selectDailySigaResource(
  resources: CatalogueResource[],
  formats: readonly ResourceFormat[] = ["CSV"],
): CatalogueResource {
  const match = resources.find(
    (resource) =>
      formats.includes(resource.format) &&
      resource.url.toLowerCase().endsWith(DAILY_SUFFIX),
  );
  if (!match) {
    throw new UpstreamError(
      `SIGA package has no daily CSV resource (expected a URL ending in ${DAILY_SUFFIX}); ` +
        "the monthly cut is not an acceptable substitute — it lags new entrants.",
    );
  }
  return match;
}
