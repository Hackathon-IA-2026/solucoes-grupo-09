/**
 * Pre-compute the documentary evidence behind a settled day's restrictions.
 *
 * ## The question this answers, and the one it does not
 *
 * The operator brief asks for a "causa provável" — a *predicted* cause. There
 * is no such model and there is not going to be one: the forecaster has a
 * single head per subsystem and produces a quantity, not a reason. What the
 * product can do is better and is what an auditor actually wants: given a
 * restriction ONS has already recorded, find the passage of the operating
 * instruction that states the limit which produced it.
 *
 * That is retrieval over a corpus, not inference. `apps/rag` does it, and it
 * has said since it was written which side of the boundary it expects to be
 * called from — `read_evidence`'s own docstring: *"apps/api reads what a job
 * wrote, and never calls a model to serve a page."*
 *
 * ## Why a job rather than a read
 *
 * Building evidence runs a language model on a free tier. A dashboard card that
 * waited for it would be a card that sometimes does not arrive, and a gateway
 * that called a model on a request path is the exact thing `ml-boundary.test.ts`
 * exists to prevent — the service on the other end is different, the defect
 * would be the same. So a schedule builds it and the read is a row.
 *
 * ## What it asks about
 *
 * Only `conjunto` rows, and only the ones that moved energy. A
 * `self_reporting_plant` row is a plant's own account of itself and would
 * double-count a plant inside a conjunto ONS also reported — the same grain
 * rule the dashboard's dominant-reason summary follows. A row at zero has
 * nothing to explain.
 */

import { config } from "../config.js";
import { readObservedReasons } from "../contract/curtailment-observed.js";
import type { SubsystemCode } from "../contract/types.js";
import type { Database } from "../database/connection.js";

/** The four, in the product's display order. */
const SUBSYSTEMS: readonly SubsystemCode[] = ["N", "NE", "SE", "S"];

/**
 * How many restrictions of one subsystem-day are worth a document lookup.
 *
 * The rows are ordered by energy, so this is "the ones that carried the day".
 * A cap rather than all of them because each is a model call against a free
 * tier, and the thirtieth-largest restriction of a day is not what anybody
 * opens the screen to ask about.
 */
const PER_SUBSYSTEM = 3;

export interface RagEvidencePayload {
  /** The civil day to explain. Absent means the most recent settled one. */
  targetDate?: string;
}

export interface RagEvidenceResult {
  targetDate: string;
  /** Restrictions submitted for a document lookup. */
  asked: number;
  /** Subsystems whose day had no `conjunto` restriction to explain. */
  empty: number;
  detail: string;
}

export const RAG_EVIDENCE_SCHEDULE = {
  id: "rag:evidence",
  /*
    Half past eight, Brasília — twenty minutes after the corpus refresh, so the
    documents a lookup might cite are the ones fetched this morning rather than
    yesterday's. Both are before the 09:00 gate.
  */
  pattern: "30 8 * * *",
  timeZone: "America/Sao_Paulo",
  payload: { kind: "rag_evidence" as const, payload: {} as RagEvidencePayload },
};

export async function runRagEvidence(
  db: Database,
  payload: RagEvidencePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<RagEvidenceResult> {
  if (!config.ragUrl) {
    throw new Error("rag:evidence ran with WATTSTEER_RAG_URL unset");
  }
  const targetDate = payload.targetDate ?? settledDay();
  const from = new Date(`${targetDate}T03:00:00.000Z`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

  let asked = 0;
  let empty = 0;
  for (const subsystem of SUBSYSTEMS) {
    const observation = await readObservedReasons(db, {
      asOf: new Date(),
      subsystem,
      from,
      to,
      limit: 50,
    });
    const rows = observation.rows
      .filter((row) => row.grain === "conjunto" && row.constrainedOffMwh > 0)
      .slice(0, PER_SUBSYSTEM);
    if (rows.length === 0) {
      empty += 1;
      continue;
    }
    for (const row of rows) {
      const url = new URL("/internal/rag/evidence", config.ragUrl);
      url.searchParams.set("subsystem", subsystem);
      url.searchParams.set("target_date", targetDate);
      url.searchParams.set("reason", row.reason);
      if (row.description !== null) {
        url.searchParams.set("description", row.description);
      }
      const response = await fetchImpl(url, {
        method: "POST",
        headers: config.ragToken ? { "x-access-token": config.ragToken } : {},
        // Generous, because this is a model call and it is a schedule's time to
        // spend rather than a reader's.
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        /*
          Logged and carried past, not thrown. The free tier answers "waiting
          for quota" as an ordinary outcome, and one subsystem's lookup failing
          is not a reason to leave the other three unasked — the row simply is
          not there and the card does not cite anything.
        */
        console.warn(
          `⚠️  rag:evidence ${subsystem} ${targetDate} ${row.reason} — HTTP ${response.status}`,
        );
        continue;
      }
      asked += 1;
    }
  }
  return {
    targetDate,
    asked,
    empty,
    detail: `${asked} restriction(s) submitted, ${empty} subsystem-day(s) with none`,
  };
}

/**
 * The most recent day ONS can have settled: two days back, in Brasília.
 *
 * The same offset `use-network.ts` uses on the client, and for the same reason
 * — the restriction detail is published a day or more behind, so asking about
 * yesterday returns an empty table, and an empty table reads as "nothing was
 * curtailed", which is a claim.
 */
function settledDay(): string {
  const now = new Date();
  const brasilia = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  brasilia.setUTCDate(brasilia.getUTCDate() - 2);
  return brasilia.toISOString().slice(0, 10);
}
