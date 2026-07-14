import { describe, expect, test } from "bun:test";
import {
  ApiError,
  initialScrapeState,
  type JobRecord,
  MAX_POLL_ERRORS,
  type ScrapeEvent,
  type ScrapeRequest,
  type ScrapeResult,
  transition,
  type ZalytixClient,
} from "@zalytix/core";
import { runScrape } from "../src/lib/scrape-controller";

const request: ScrapeRequest = { appId: "42", store: "apple", limit: 50 };

const result: ScrapeResult = {
  store: "apple",
  appId: "42",
  country: "us",
  count: 0,
  partial: false,
  reviews: [],
};

const noSleep = () => Promise.resolve();

/** A fake client scripted with canned submit/poll behaviors. */
function fakeClient(options: {
  submit?: () => Promise<string>;
  polls: Array<() => Promise<JobRecord>>;
}): ZalytixClient {
  let call = 0;
  return {
    submitJob: options.submit ?? (() => Promise.resolve("job-1")),
    jobStatus: () => {
      const poll = options.polls[Math.min(call, options.polls.length - 1)];
      call++;
      return poll();
    },
  } as unknown as ZalytixClient;
}

/** Run the controller and capture events + the machine's final state. */
async function drive(client: ZalytixClient, signal?: AbortSignal) {
  const events: ScrapeEvent[] = [];
  let state = transition(initialScrapeState, { type: "SUBMIT", request });
  await runScrape(
    client,
    request,
    (event) => {
      events.push(event);
      state = transition(state, event);
    },
    { signal: signal ?? new AbortController().signal, sleep: noSleep },
  );
  return { events, state };
}

describe("runScrape", () => {
  test("drives the machine to completed on the happy path", async () => {
    const client = fakeClient({
      polls: [
        () => Promise.resolve({ id: "job-1", status: "waiting" as const }),
        () => Promise.resolve({ id: "job-1", status: "active" as const }),
        () => Promise.resolve({ id: "job-1", status: "completed" as const, result }),
      ],
    });
    const { state, events } = await drive(client);
    expect(state).toMatchObject({ phase: "completed", jobId: "job-1" });
    expect(events[0]).toEqual({ type: "SUBMIT_OK", jobId: "job-1" });
    expect(events.at(-1)).toMatchObject({ type: "JOB_UPDATE" });
  });

  test("stops polling once the job fails and surfaces the error", async () => {
    const client = fakeClient({
      polls: [
        () => Promise.resolve({ id: "job-1", status: "failed" as const, error: "boom" }),
        () => Promise.reject(new Error("should not poll again")),
      ],
    });
    const { state, events } = await drive(client);
    expect(state).toMatchObject({ phase: "failed", message: "boom" });
    expect(events.filter((event) => event.type === "JOB_UPDATE")).toHaveLength(1);
  });

  test("submit failure dispatches SUBMIT_ERROR with the API message", async () => {
    const client = fakeClient({
      submit: () => Promise.reject(new ApiError(400, "bad appId")),
      polls: [],
    });
    const { state } = await drive(client);
    expect(state).toMatchObject({
      phase: "failed",
      message: "bad appId",
      retryable: false,
    });
  });

  test("tolerates transient poll errors, then recovers", async () => {
    const client = fakeClient({
      polls: [
        () => Promise.reject(new ApiError(503, "queue blip")),
        () => Promise.reject(new ApiError(503, "queue blip")),
        () => Promise.resolve({ id: "job-1", status: "completed" as const, result }),
      ],
    });
    const { state } = await drive(client);
    expect(state.phase).toBe("completed");
  });

  test("gives up after MAX_POLL_ERRORS consecutive failures", async () => {
    let polls = 0;
    const client = fakeClient({
      polls: [
        () => {
          polls++;
          return Promise.reject(new ApiError(503, "down"));
        },
      ],
    });
    const { state } = await drive(client);
    expect(polls).toBe(MAX_POLL_ERRORS);
    expect(state).toMatchObject({ phase: "failed", retryable: true });
  });

  test("an aborted signal stops the loop without dispatching", async () => {
    const controller = new AbortController();
    const client = fakeClient({
      polls: [
        () => {
          controller.abort();
          return Promise.resolve({ id: "job-1", status: "active" as const });
        },
      ],
    });
    const { state, events } = await drive(client, controller.signal);
    // Only the SUBMIT_OK from before the abort; the post-abort poll is dropped.
    expect(events).toEqual([{ type: "SUBMIT_OK", jobId: "job-1" }]);
    expect(state.phase).toBe("queued");
  });
});
