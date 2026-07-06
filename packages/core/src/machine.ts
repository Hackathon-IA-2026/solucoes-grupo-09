import type { JobProgress, JobRecord, ScrapeRequest, ScrapeResult } from "./types";

/**
 * The scrape-flow finite-state machine, as a *pure* reducer. All UI state for
 * a scrape lives here as a discriminated union — there is no combination of
 * booleans that can drift into an impossible state, and every transition is
 * unit-testable without React or a network.
 *
 *   idle ── SUBMIT ──▶ submitting ── SUBMIT_OK ──▶ queued ─▶ scraping ─▶ completed
 *                            │                        │          │
 *                      SUBMIT_ERROR              JOB_UPDATE  JOB_UPDATE
 *                            ▼                        ▼          ▼
 *                          failed ◀───────────────────┴──────────┘
 *
 * `CANCEL`/`RESET` return to `idle` from anywhere. Transient poll errors are
 * tolerated up to `MAX_POLL_ERRORS` consecutive failures before giving up —
 * a single dropped request must not kill a 5-minute scrape.
 */

/** Consecutive poll failures tolerated before the machine gives up. */
export const MAX_POLL_ERRORS = 5;

export type ScrapeState =
  | { phase: "idle" }
  | { phase: "submitting"; request: ScrapeRequest }
  | {
      phase: "queued";
      request: ScrapeRequest;
      jobId: string;
      pollErrors: number;
    }
  | {
      phase: "scraping";
      request: ScrapeRequest;
      jobId: string;
      pollErrors: number;
      /** Live progress from the job record, when the backend reports it. */
      progress?: JobProgress;
    }
  | { phase: "completed"; request: ScrapeRequest; jobId: string; result: ScrapeResult }
  | {
      phase: "failed";
      request: ScrapeRequest | null;
      message: string;
      /** Whether retrying the same request is worth offering. */
      retryable: boolean;
    };

export type ScrapeEvent =
  | { type: "SUBMIT"; request: ScrapeRequest }
  | { type: "SUBMIT_OK"; jobId: string }
  | { type: "SUBMIT_ERROR"; message: string; retryable: boolean }
  | { type: "JOB_UPDATE"; record: JobRecord }
  | { type: "POLL_ERROR"; message: string }
  | { type: "CANCEL" }
  | { type: "RESET" };

export const initialScrapeState: ScrapeState = { phase: "idle" };

/** True while a scrape is in flight (submit → done), for disabling inputs. */
export function isBusy(state: ScrapeState): boolean {
  return (
    state.phase === "submitting" || state.phase === "queued" || state.phase === "scraping"
  );
}

/**
 * Pure transition function. Events that don't apply in the current state are
 * ignored (the state is returned unchanged) — late poll responses after a
 * cancel, double submits, etc. are all no-ops by construction.
 */
export function transition(state: ScrapeState, event: ScrapeEvent): ScrapeState {
  // Universal escapes first: they apply from any state.
  if (event.type === "RESET" || event.type === "CANCEL") return { phase: "idle" };

  switch (state.phase) {
    case "idle":
    case "completed":
    case "failed":
      if (event.type === "SUBMIT") {
        return { phase: "submitting", request: event.request };
      }
      return state;

    case "submitting":
      if (event.type === "SUBMIT_OK") {
        return {
          phase: "queued",
          request: state.request,
          jobId: event.jobId,
          pollErrors: 0,
        };
      }
      if (event.type === "SUBMIT_ERROR") {
        return {
          phase: "failed",
          request: state.request,
          message: event.message,
          retryable: event.retryable,
        };
      }
      return state;

    case "queued":
    case "scraping":
      if (event.type === "JOB_UPDATE") {
        const { record } = event;
        if (record.id !== state.jobId) return state; // stale response for an old job
        switch (record.status) {
          case "waiting":
            return { ...state, phase: "queued", pollErrors: 0 };
          case "active":
            return {
              ...state,
              phase: "scraping",
              pollErrors: 0,
              // Keep the last known progress if a poll omits it (progress is
              // best-effort and must never move backwards to undefined).
              progress:
                record.progress ??
                (state.phase === "scraping" ? state.progress : undefined),
            };
          case "completed":
            if (!record.result) {
              // A completed job must carry a result; treat the contract
              // violation as a failure rather than rendering an empty screen.
              return {
                phase: "failed",
                request: state.request,
                message: "The scrape finished but returned no data. Please try again.",
                retryable: true,
              };
            }
            return {
              phase: "completed",
              request: state.request,
              jobId: state.jobId,
              result: record.result,
            };
          case "failed":
            return {
              phase: "failed",
              request: state.request,
              message: record.error ?? "The scrape failed. Please try again.",
              retryable: true,
            };
        }
      }
      if (event.type === "POLL_ERROR") {
        const pollErrors = state.pollErrors + 1;
        if (pollErrors >= MAX_POLL_ERRORS) {
          return {
            phase: "failed",
            request: state.request,
            message:
              "We lost contact with the server while scraping. Check your connection and try again.",
            retryable: true,
          };
        }
        return { ...state, pollErrors };
      }
      return state;
  }
}
