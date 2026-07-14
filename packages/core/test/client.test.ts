import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, pollDelayMs, ZalytixClient } from "../src/client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as unknown as typeof fetch;
}

describe("ZalytixClient", () => {
  test("normalizes a trailing slash on the base URL", () => {
    expect(new ZalytixClient("http://localhost:3000/").baseUrl).toBe(
      "http://localhost:3000",
    );
  });

  test("appInfo builds the query string", async () => {
    let seen = "";
    stubFetch((url) => {
      seen = url;
      return Response.json({ store: "apple", appId: "42", country: "gb", appInfo: null });
    });
    const client = new ZalytixClient("http://api.test");
    const result = await client.appInfo({ appId: "42", store: "apple", country: "gb" });
    expect(seen).toBe("http://api.test/app?appId=42&store=apple&country=gb");
    expect(result.appInfo).toBeNull();
  });

  test("submitJob POSTs the request and returns the id", async () => {
    let seenBody: unknown;
    stubFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body));
      return Response.json({ id: "job-9", status: "waiting" }, { status: 202 });
    });
    const client = new ZalytixClient("http://api.test");
    const id = await client.submitJob({ appId: "com.x.y", limit: 100 });
    expect(id).toBe("job-9");
    expect(seenBody).toEqual({ appId: "com.x.y", limit: 100 });
  });

  test("jobStatus URL-encodes the id", async () => {
    let seen = "";
    stubFetch((url) => {
      seen = url;
      return Response.json({ id: "a/b", status: "waiting" });
    });
    await new ZalytixClient("http://api.test").jobStatus("a/b");
    expect(seen).toBe("http://api.test/reviews/jobs/a%2Fb");
  });

  test("API error bodies surface their message and status", async () => {
    stubFetch(() => Response.json({ error: "Job not found" }, { status: 404 }));
    const client = new ZalytixClient("http://api.test");
    try {
      await client.jobStatus("nope");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
      expect((error as ApiError).message).toBe("Job not found");
      expect((error as ApiError).retryable).toBe(false);
    }
  });

  test("5xx and network failures are retryable", async () => {
    stubFetch(() => Response.json({ error: "queue down" }, { status: 503 }));
    const client = new ZalytixClient("http://api.test");
    await expect(client.jobStatus("x")).rejects.toMatchObject({ retryable: true });

    globalThis.fetch = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    await expect(client.jobStatus("x")).rejects.toMatchObject({
      status: 0,
      retryable: true,
    });
  });

  test("non-JSON error bodies fall back to a status message", async () => {
    stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const client = new ZalytixClient("http://api.test");
    await expect(client.jobStatus("x")).rejects.toMatchObject({
      status: 502,
      message: "Request failed (502)",
    });
  });

  test("aborts propagate as AbortError, not ApiError", async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        new DOMException("Aborted", "AbortError"),
      )) as unknown as typeof fetch;
    const client = new ZalytixClient("http://api.test");
    await expect(client.jobStatus("x")).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("pollDelayMs", () => {
  test("fast at first, backing off for long jobs", () => {
    expect(pollDelayMs(0)).toBe(1000);
    expect(pollDelayMs(4)).toBe(1000);
    expect(pollDelayMs(5)).toBe(2000);
    expect(pollDelayMs(14)).toBe(2000);
    expect(pollDelayMs(15)).toBe(5000);
    expect(pollDelayMs(100)).toBe(5000);
  });
});
