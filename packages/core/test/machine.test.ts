import { describe, expect, test } from "bun:test";
import type { ScrapeEvent, ScrapeState } from "../src/machine";
import { initialScrapeState, isBusy, MAX_POLL_ERRORS, transition } from "../src/machine";
import type { JobRecord, ScrapeRequest, ScrapeResult } from "../src/types";

const request: ScrapeRequest = { appId: "com.spotify.music", store: "google", limit: 50 };

const result: ScrapeResult = {
  store: "google",
  appId: "com.spotify.music",
  country: "us",
  count: 1,
  partial: false,
  reviews: [
    {
      store: "google",
      id: "r1",
      userName: "sam",
      title: "",
      body: "great",
      rating: 5,
      date: "2026-01-01T00:00:00Z",
      developerResponse: null,
      appId: "com.spotify.music",
      country: "us",
    },
  ],
};

function record(status: JobRecord["status"], extra: Partial<JobRecord> = {}): JobRecord {
  return { id: "job-1", status, ...extra };
}

/** Drive the machine through a list of events. */
function run(events: ScrapeEvent[], from: ScrapeState = initialScrapeState): ScrapeState {
  return events.reduce(transition, from);
}

describe("happy path", () => {
  test("idle → submitting → queued → scraping → completed", () => {
    let state = run([{ type: "SUBMIT", request }]);
    expect(state).toEqual({ phase: "submitting", request });

    state = transition(state, { type: "SUBMIT_OK", jobId: "job-1" });
    expect(state).toEqual({ phase: "queued", request, jobId: "job-1", pollErrors: 0 });

    state = transition(state, { type: "JOB_UPDATE", record: record("active") });
    expect(state).toEqual({ phase: "scraping", request, jobId: "job-1", pollErrors: 0 });

    state = transition(state, {
      type: "JOB_UPDATE",
      record: record("completed", { result }),
    });
    expect(state).toEqual({ phase: "completed", request, jobId: "job-1", result });
  });

  test("job can complete straight from queued (fast scrape)", () => {
    const state = run([
      { type: "SUBMIT", request },
      { type: "SUBMIT_OK", jobId: "job-1" },
      { type: "JOB_UPDATE", record: record("completed", { result }) },
    ]);
    expect(state.phase).toBe("completed");
  });
});

describe("failures", () => {
  test("submit error carries message + retryability", () => {
    const state = run([
      { type: "SUBMIT", request },
      { type: "SUBMIT_ERROR", message: "Job queue unavailable", retryable: true },
    ]);
    expect(state).toEqual({
      phase: "failed",
      request,
      message: "Job queue unavailable",
      retryable: true,
    });
  });

  test("failed job surfaces the server error", () => {
    const state = run([
      { type: "SUBMIT", request },
      { type: "SUBMIT_OK", jobId: "job-1" },
      { type: "JOB_UPDATE", record: record("failed", { error: "blocked upstream" }) },
    ]);
    expect(state).toMatchObject({ phase: "failed", message: "blocked upstream" });
  });

  test("completed job without a result is treated as a failure", () => {
    const state = run([
      { type: "SUBMIT", request },
      { type: "SUBMIT_OK", jobId: "job-1" },
      { type: "JOB_UPDATE", record: record("completed") },
    ]);
    expect(state).toMatchObject({ phase: "failed", retryable: true });
  });

  test("poll errors are tolerated below the threshold, fatal at it", () => {
    let state = run([
      { type: "SUBMIT", request },
      { type: "SUBMIT_OK", jobId: "job-1" },
      { type: "JOB_UPDATE", record: record("active") },
    ]);
    for (let i = 0; i < MAX_POLL_ERRORS - 1; i++) {
      state = transition(state, { type: "POLL_ERROR", message: "net down" });
      expect(state.phase).toBe("scraping");
    }
    state = transition(state, { type: "POLL_ERROR", message: "net down" });
    expect(state).toMatchObject({ phase: "failed", retryable: true });
  });

  test("a successful poll resets the error counter", () => {
    const state = run([
      { type: "SUBMIT", request },
      { type: "SUBMIT_OK", jobId: "job-1" },
      { type: "POLL_ERROR", message: "x" },
      { type: "POLL_ERROR", message: "x" },
      { type: "JOB_UPDATE", record: record("active") },
    ]);
    expect(state).toMatchObject({ phase: "scraping", pollErrors: 0 });
  });
});

describe("robustness (invalid events are no-ops)", () => {
  test("stale job updates for a different job id are ignored", () => {
    const scraping = run([
      { type: "SUBMIT", request },
      { type: "SUBMIT_OK", jobId: "job-1" },
      { type: "JOB_UPDATE", record: record("active") },
    ]);
    const after = transition(scraping, {
      type: "JOB_UPDATE",
      record: { id: "old-job", status: "completed", result },
    });
    expect(after).toBe(scraping);
  });

  test("double SUBMIT while in flight is ignored", () => {
    const submitting = run([{ type: "SUBMIT", request }]);
    expect(transition(submitting, { type: "SUBMIT", request })).toBe(submitting);
  });

  test("job updates in idle are ignored", () => {
    const after = transition(initialScrapeState, {
      type: "JOB_UPDATE",
      record: record("completed", { result }),
    });
    expect(after).toBe(initialScrapeState);
  });

  test("CANCEL returns to idle from any phase", () => {
    for (const events of [
      [{ type: "SUBMIT", request }] as ScrapeEvent[],
      [
        { type: "SUBMIT", request },
        { type: "SUBMIT_OK", jobId: "job-1" },
      ] as ScrapeEvent[],
    ]) {
      const state = run([...events, { type: "CANCEL" }]);
      expect(state).toEqual({ phase: "idle" });
    }
  });

  test("RESET clears a completed state so a new scrape can start", () => {
    const state = run([
      { type: "SUBMIT", request },
      { type: "SUBMIT_OK", jobId: "job-1" },
      { type: "JOB_UPDATE", record: record("completed", { result }) },
      { type: "RESET" },
      { type: "SUBMIT", request },
    ]);
    expect(state).toEqual({ phase: "submitting", request });
  });
});

describe("isBusy", () => {
  test("busy only while in flight", () => {
    expect(isBusy(initialScrapeState)).toBe(false);
    expect(isBusy({ phase: "submitting", request })).toBe(true);
    expect(isBusy({ phase: "queued", request, jobId: "j", pollErrors: 0 })).toBe(true);
    expect(isBusy({ phase: "scraping", request, jobId: "j", pollErrors: 0 })).toBe(true);
    expect(isBusy({ phase: "completed", request, jobId: "j", result })).toBe(false);
    expect(isBusy({ phase: "failed", request, message: "x", retryable: true })).toBe(
      false,
    );
  });
});
