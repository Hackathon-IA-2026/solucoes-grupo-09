/**
 * The ONS passage behind a settled restriction, reduced to what a card can say.
 *
 * ## Why this is a narrowing and not a type
 *
 * `/v1/curtailment/evidence` returns what the retrieval service stored: a
 * verdict, a trace, a numbers whitelist, several claims and every citation
 * behind each. That is an audit record and it is right that it is one — the
 * whole point of the corpus is that a claim can be checked.
 *
 * A dashboard card is not an audit. It has room for one line, and the line has
 * to be the strongest thing the record supports: *which document, which
 * revision, which page*. The rest stays on the wire for whoever wants it.
 *
 * ## What it refuses
 *
 * A row whose verdict is not `found` produces nothing. The service has three
 * outcomes and only one of them is an answer — `insufficient` means the gates
 * rejected every claim, and a card that printed its citations anyway would be
 * showing the passages a rule had just decided do not support the claim.
 */

/** One citation, as a card states it. */
export interface EvidenceCitation {
  /** `IO-ON.NE.5NE` — ONS's own identifier, never translated. */
  documentCode: string;
  /** `Rev.61`, or `null` where the document carries no revision. */
  revision: string | null;
  /** 1-based page, or `null` for an HTML source with no pagination. */
  page: number | null;
  title: string;
  url: string;
}

interface WireCitation {
  external_id?: unknown;
  revision?: unknown;
  title?: unknown;
  url?: unknown;
  locator?: { page?: unknown } | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The first citation of the first supported claim, or `null`.
 *
 * First rather than best: the service ranks them, and a client that re-ranked
 * would be forming a second opinion about evidence it did not retrieve.
 */
export function firstCitation(rows: unknown): EvidenceCitation | null {
  if (!Array.isArray(rows)) {
    return null;
  }
  for (const row of rows) {
    if (!isRecord(row) || row.verdict !== "found") {
      continue;
    }
    const payload = isRecord(row.payload) ? row.payload : null;
    const items = payload !== null && Array.isArray(payload.items) ? payload.items : [];
    for (const item of items) {
      if (!(isRecord(item) && Array.isArray(item.citations))) {
        continue;
      }
      const citation = item.citations[0] as WireCitation | undefined;
      const documentCode = text(citation?.external_id);
      const url = text(citation?.url);
      if (citation === undefined || documentCode === null || url === null) {
        continue;
      }
      const page = citation.locator?.page;
      return {
        documentCode,
        revision: text(citation.revision),
        page: typeof page === "number" ? page : null,
        title: text(citation.title) ?? documentCode,
        url,
      };
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the day's evidence rows.
 *
 * **Not through `ApiClient`, and that is the honest place for the seam.** The
 * generated client decodes into registered wire types, and this payload has
 * none: it is the retrieval service's audit record, owned by `apps/rag`'s
 * schema rather than by the contract `packages/core` generates from. Adding a
 * type for it there would assert that the gateway's contract governs a shape it
 * only forwards.
 *
 * So it is a plain read with a narrow return, and everything that could be
 * wrong with the body is handled by `firstCitation` — which treats an
 * unexpected shape as "no citation" rather than as an error, because the card
 * it annotates is already drawn.
 */
export async function readEvidence(
  baseUrl: string,
  query: { subsystem: string; date: string },
  signal?: AbortSignal,
): Promise<EvidenceCitation | null> {
  const url = new URL("/v1/curtailment/evidence", baseUrl);
  url.searchParams.set("subsystem", query.subsystem);
  url.searchParams.set("date", query.date);
  const response = await fetch(url, { signal }).catch(() => null);
  if (response === null || !response.ok) {
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  return firstCitation(
    typeof body === "object" && body !== null ? (body as { rows?: unknown }).rows : null,
  );
}
