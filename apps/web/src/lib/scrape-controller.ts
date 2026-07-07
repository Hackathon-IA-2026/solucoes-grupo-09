import {
  ApiError,
  MAX_POLL_ERRORS,
  type NoviqClient,
  pollDelayMs,
  type ScrapeEvent,
  type ScrapeRequest,
} from "@noviq/core";

export interface ControllerOptions {
  signal: AbortSignal;
  /** Injectable for tests; defaults to real setTimeout sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      return resolve();
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Drives one scrape job end-to-end: submit, then poll until the job reaches a
 * terminal state, the signal aborts, or too many consecutive polls fail.
 * All state decisions live in the machine — this function only reports what
 * the network said via `dispatch`, which makes it a thin, fully-testable
 * orchestration layer (no React, no timers in tests).
 */
export async function runScrape(
  client: NoviqClient,
  request: ScrapeRequest,
  dispatch: (event: ScrapeEvent) => void,
  { signal, sleep = defaultSleep }: ControllerOptions,
): Promise<void> {
  let jobId: string;
  try {
    jobId = await client.submitJob(request, signal);
  } catch (error) {
    if (signal.aborted) {
      return;
    }
    const apiError = error instanceof ApiError ? error : null;
    dispatch({
      type: "SUBMIT_ERROR",
      message: apiError?.message ?? "Something went wrong submitting the scrape.",
      retryable: apiError?.retryable ?? true,
    });
    return;
  }
  if (signal.aborted) {
    return;
  }
  dispatch({ type: "SUBMIT_OK", jobId });

  let consecutiveErrors = 0;
  for (let attempt = 0; ; attempt++) {
    await sleep(pollDelayMs(attempt), signal);
    if (signal.aborted) {
      return;
    }

    try {
      const record = await client.jobStatus(jobId, signal);
      if (signal.aborted) {
        return;
      }
      consecutiveErrors = 0;
      dispatch({ type: "JOB_UPDATE", record });
      if (record.status === "completed" || record.status === "failed") {
        return;
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      consecutiveErrors++;
      dispatch({
        type: "POLL_ERROR",
        message: error instanceof Error ? error.message : "poll failed",
      });
      // Mirrors the machine's threshold: it has already moved to `failed`,
      // so polling further would dispatch into a dead state.
      if (consecutiveErrors >= MAX_POLL_ERRORS) {
        return;
      }
    }
  }
}
