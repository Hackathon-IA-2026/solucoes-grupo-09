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
 * The few distinct restrictions of each settled subsystem-day that moved
 * energy, with the ones that name an ONS document first — `pickRestrictions`
 * says why. Each run looks back over the last few settled days and asks only
 * what no earlier run answered, so a day ONS published late, or a lookup a
 * spent quota stopped, is picked up the next morning instead of never.
 */

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core/constants";
import { config } from "../config.js";
import {
  type ObservedReasonRow,
  readObservedReasons,
} from "../contract/curtailment-observed.js";
import type { Database } from "../database/connection.js";

/**
 * How many restrictions of one subsystem-day are worth a document lookup.
 *
 * Counted after grouping, so three means three *different* questions. Before
 * the grouping it meant the three largest rows, and on the Nordeste those are
 * routinely three conjuntos carrying the same "Controle de frequência do SIN"
 * — one question asked three times, about the one record the corpus says it
 * cannot answer, while the transmission limits it can cite went unasked.
 */
const PER_SUBSYSTEM = 3;

/**
 * How many settled days each run looks at.
 *
 * A day is asked about once the restriction detail exists, and ONS publishes
 * that detail a day or more late, sometimes later. A run that only looked at
 * one day left every day that was late, or that met a spent quota, without
 * evidence for good. Looking back over a few days and skipping what is already
 * answered makes the run a catch-up rather than a one-shot.
 */
const LOOKBACK_DAYS = 3;

/**
 * An identifier ONS uses to cite its own paper: an operating instruction,
 * a technical note, or an intervention request.
 *
 * The same shapes `apps/rag`'s `retrieve.CODE` searches literally and its
 * relevance gate checks a citation against. A record that carries one is the
 * record the corpus is most likely to be able to cite.
 */
const NAMED_DOCUMENT = /\b(?:IO|IT|RT|NT)-[A-Z0-9.]{2,}|\bSGI\b/i;

export interface RagEvidencePayload {
  /** One civil day to explain. Absent means the last few settled ones. */
  targetDate?: string;
}

export interface RagEvidenceResult {
  targetDates: string[];
  /** Restrictions the service answered. */
  asked: number;
  /** Lookups the provider's quota stopped; the next run asks them again. */
  deferred: number;
  /** Restrictions a previous run already answered. */
  skipped: number;
  /** Subsystem-days with no `conjunto` restriction to explain. */
  empty: number;
  detail: string;
}

/** One question for the evidence service: a reason and what ONS wrote about it. */
export interface Restriction {
  reason: string;
  description: string | null;
  constrainedOffMwh: number;
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

/**
 * The restrictions of one subsystem-day worth asking about, best first.
 *
 * Only `conjunto` rows, and only the ones that moved energy. A
 * `self_reporting_plant` row is a plant's own account of itself and would
 * double-count a plant inside a conjunto ONS also reported — the same grain
 * rule the dashboard's dominant-reason summary follows. A row at zero has
 * nothing to explain.
 *
 * Grouped by (reason, description), because the question the service answers
 * is built from exactly those two and nothing about the conjunto. Then a
 * record that names a document goes first, because that is the record whose
 * rule the corpus holds; energy decides among the rest.
 */
export function pickRestrictions(
  rows: readonly ObservedReasonRow[],
  limit: number = PER_SUBSYSTEM,
): Restriction[] {
  const grouped = new Map<string, Restriction>();
  for (const row of rows) {
    if (row.grain !== "conjunto" || !(row.constrainedOffMwh > 0)) {
      continue;
    }
    const key = `${row.reason}\u0000${row.description ?? ""}`;
    const seen = grouped.get(key);
    if (seen === undefined) {
      grouped.set(key, {
        reason: row.reason,
        description: row.description,
        constrainedOffMwh: row.constrainedOffMwh,
      });
    } else {
      seen.constrainedOffMwh += row.constrainedOffMwh;
    }
  }
  const names = (one: Restriction) => NAMED_DOCUMENT.test(one.description ?? "");
  return [...grouped.values()]
    .sort(
      (a, b) =>
        Number(names(b)) - Number(names(a)) || b.constrainedOffMwh - a.constrainedOffMwh,
    )
    .slice(0, limit);
}

/**
 * Whether a stored evidence row already answers this restriction.
 *
 * Matched on the question the service stored, which it builds from the record's
 * description and declared reason. A row the quota stopped is not an answer: it
 * is the service saying "ask me later", and a catch-up that honoured it as one
 * would never ask again.
 */
export function alreadyAnswered(stored: unknown, restriction: Restriction): boolean {
  if (!Array.isArray(stored)) {
    return false;
  }
  return stored.some((row) => {
    const reason = typeof row?.reason === "string" ? row.reason : "";
    const question =
      typeof row?.payload?.question === "string" ? row.payload.question : "";
    if (reason.startsWith("quota_exhausted")) {
      return false;
    }
    if (!question.includes(`Razão declarada: ${restriction.reason}.`)) {
      return false;
    }
    return restriction.description === null || question.includes(restriction.description);
  });
}

export async function runRagEvidence(
  db: Database,
  payload: RagEvidencePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<RagEvidenceResult> {
  if (!config.ragUrl) {
    throw new Error("rag:evidence ran with WATTSTEER_RAG_URL unset");
  }
  const ragUrl = config.ragUrl;
  const headers: Record<string, string> = config.ragToken
    ? { "x-access-token": config.ragToken }
    : {};
  const targetDates = payload.targetDate
    ? [payload.targetDate]
    : settledDays(LOOKBACK_DAYS);
  const tally = { asked: 0, deferred: 0, skipped: 0, empty: 0 };

  for (const targetDate of targetDates) {
    const from = new Date(`${targetDate}T03:00:00.000Z`);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    for (const subsystem of SUBSYSTEM_DISPLAY_ORDER) {
      const observation = await readObservedReasons(db, {
        asOf: new Date(),
        subsystem,
        from,
        to,
        // Every entity row of the day, not the largest few: the grouping below
        // is what picks, and a row cut here never reaches it. One subsystem-day
        // is bounded, so this cap only guards against a runaway read.
        limit: 5000,
      });
      const restrictions = pickRestrictions(observation.rows);
      if (restrictions.length === 0) {
        tally.empty += 1;
        continue;
      }
      const stored = await storedEvidence(
        ragUrl,
        headers,
        subsystem,
        targetDate,
        fetchImpl,
      );
      for (const restriction of restrictions) {
        if (alreadyAnswered(stored, restriction)) {
          tally.skipped += 1;
          continue;
        }
        const outcome = await askEvidence(
          ragUrl,
          headers,
          { subsystem, targetDate, restriction },
          fetchImpl,
        );
        if (outcome === "answered") {
          tally.asked += 1;
        } else if (outcome === "deferred") {
          tally.deferred += 1;
        }
      }
    }
  }
  return {
    targetDates,
    ...tally,
    detail:
      `${tally.asked} answered, ${tally.deferred} deferred on quota, ` +
      `${tally.skipped} already answered, ${tally.empty} subsystem-day(s) with none`,
  };
}

/** What the service already published for a subsystem-day, or `null` if it would not say. */
async function storedEvidence(
  ragUrl: string,
  headers: Record<string, string>,
  subsystem: string,
  targetDate: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const url = new URL("/internal/rag/evidence", ragUrl);
  url.searchParams.set("subsystem", subsystem);
  url.searchParams.set("target_date", targetDate);
  // The table is append-only and a deferred lookup adds a row per run, so a
  // small window could push an older answer out of sight and ask again.
  url.searchParams.set("limit", "1000");
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (response === null || !response.ok) {
    // Asking again is the safe side of not knowing: the table is append-only
    // and a duplicate answer is a row, not a contradiction.
    return null;
  }
  const body = (await response.json().catch(() => null)) as { rows?: unknown } | null;
  return body?.rows ?? null;
}

async function askEvidence(
  ragUrl: string,
  headers: Record<string, string>,
  query: { subsystem: string; targetDate: string; restriction: Restriction },
  fetchImpl: typeof fetch,
): Promise<"answered" | "deferred" | "failed"> {
  const { subsystem, targetDate, restriction } = query;
  const url = new URL("/internal/rag/evidence", ragUrl);
  url.searchParams.set("subsystem", subsystem);
  url.searchParams.set("target_date", targetDate);
  url.searchParams.set("reason", restriction.reason);
  if (restriction.description !== null) {
    url.searchParams.set("description", restriction.description);
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    // Generous, because this is a model call and it is a schedule's time to
    // spend rather than a reader's.
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null);
  if (response === null || !response.ok) {
    /*
      Logged and carried past, not thrown: one lookup failing is not a reason
      to leave the other subsystems unasked. The next run asks again, because
      nothing was stored.
    */
    console.warn(
      `⚠️  rag:evidence ${subsystem} ${targetDate} ${restriction.reason} — ` +
        `HTTP ${response?.status ?? "unreachable"}`,
    );
    return "failed";
  }
  /*
    A 200 is not an answer yet. The service stores a spent quota as an
    `insufficient` row with a `quota_exhausted_*` reason, and counting that as
    asked is what let a run report success while explaining nothing.
  */
  const document = (await response.json().catch(() => null)) as {
    reason?: unknown;
  } | null;
  const reason = typeof document?.reason === "string" ? document.reason : "";
  return reason.startsWith("quota_exhausted") ? "deferred" : "answered";
}

/**
 * The last `count` days ONS can have settled: from two days back, in Brasília.
 *
 * Two days back for the same reason `use-network.ts` uses on the client — the
 * restriction detail is published a day or more behind, so asking about
 * yesterday returns an empty table, and an empty table reads as "nothing was
 * curtailed", which is a claim.
 */
export function settledDays(count: number, now: Date = new Date()): string[] {
  const days: string[] = [];
  for (let back = 2; back < 2 + count; back += 1) {
    const brasilia = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    brasilia.setUTCDate(brasilia.getUTCDate() - back);
    days.push(brasilia.toISOString().slice(0, 10));
  }
  return days;
}
