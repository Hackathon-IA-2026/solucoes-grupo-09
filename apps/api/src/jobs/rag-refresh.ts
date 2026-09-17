/**
 * The RAG's daily catch-up, as work this schedule owns.
 *
 * ## Why the worker asks and the RAG does
 *
 * The evidence corpus has two halves with different lifetimes. The normative
 * one — the operating instructions and the network procedures — changes a few
 * times a year, and a one-off ingest is the right answer for it. The daily
 * record does not: BDO and IPDO are published every day, and without something
 * fetching them "the date the corpus covers" stops moving while every other
 * signal keeps saying the service is healthy. A question about last Tuesday
 * answers `corpus_no_coverage_for_date`, and nothing anywhere explains why.
 *
 * A cron service of its own cannot do it. A Railway volume attaches to exactly
 * one service and the document store lives on the RAG's, so a second process
 * could not write `/data/rag-store`. `data-platform.md` also asks for one
 * scheduler rather than two, and this is it. So the split is: the worker owns
 * *when*, the RAG owns *how*, and the wire between them is one authenticated
 * POST.
 *
 * ## Why it does not wait
 *
 * The endpoint answers 202 and works in the background, because a day of BDO is
 * a couple of dozen documents and the embedding step is rate-limited by the
 * provider. This job's success means *the refresh was accepted*, which is the
 * only thing it can honestly claim from here. Whether the corpus grew is a
 * question for `/internal/rag/status`, whose `corpus_version` carries the
 * newest `fetched_at` — so a refresh that did something changes it, and a run
 * that found nothing new leaves it alone, which is also correct.
 */

import { config } from "../config.js";

/** The publisher's clock, which is the only one that decides what exists yet. */
export const RAG_REFRESH_TIME_ZONE = "America/Sao_Paulo";

/** A repeatable job the queue registers, in the shape `runner.schedule` takes. */
export interface RagRefreshSchedule {
  id: string;
  pattern: string;
  timeZone: string;
  payload: { kind: "rag_refresh"; payload: RagRefreshPayload };
}

export interface RagRefreshPayload {
  /**
   * How many days back to fetch.
   *
   * Two rather than one, and the extra day is not belt-and-braces: ONS
   * publishes the daily bulletin late and sometimes republishes it, so a job
   * that asks only for yesterday inherits whatever was there at the moment it
   * ran. Re-fetching the day before costs one conditional request per source
   * and closes the hole. The ingest is content-addressed, so a document that
   * has not changed is not re-parsed and not re-embedded.
   */
  days?: number;
}

export interface RagRefreshResult {
  accepted: boolean;
  days: number;
  /** What the service said, for a job log an operator can read. */
  detail: string;
}

/**
 * Ten past eight, Brasília civil time.
 *
 * The first draft read `"10 4 * * *"` with no zone, which a `JobSchedule`
 * evaluates in UTC — 01:10 in Brasília. Fired by hand at 03:56 UTC it returned
 * two 404s and nothing else, and the 404s are the answer: ONS had published
 * neither the previous day's bulletin index nor that morning's IPDO, because at
 * one in the morning neither exists yet. A schedule that asks before the
 * publisher has published is a schedule that succeeds every day and fetches
 * nothing, which is the failure this whole job was written to prevent, arriving
 * by a different door.
 *
 * So: a zone rather than an implicit UTC, and a morning hour rather than an
 * overnight one. Before the 09:00 gate, so a day the RAG is asked about is a
 * day it has had a chance to fetch.
 */
export const RAG_REFRESH_SCHEDULE: RagRefreshSchedule = {
  id: "rag:refresh",
  pattern: "10 8 * * *",
  timeZone: RAG_REFRESH_TIME_ZONE,
  payload: { kind: "rag_refresh", payload: { days: 2 } },
};

export async function runRagRefresh(
  payload: RagRefreshPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<RagRefreshResult> {
  const days = payload.days ?? 2;
  if (!config.ragUrl) {
    // Unreachable through the schedule, which is not registered without a URL.
    // Thrown rather than returned false: a job that reports success for work it
    // never attempted is worse than one that fails loudly.
    throw new Error("rag:refresh ran with WATTSTEER_RAG_URL unset");
  }
  const url = new URL("/internal/rag/refresh", config.ragUrl);
  url.searchParams.set("days", String(days));
  const response = await fetchImpl(url, {
    method: "POST",
    headers: config.ragToken ? { "x-access-token": config.ragToken } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`rag:refresh refused: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  return { accepted: true, days, detail: body.slice(0, 200) };
}
