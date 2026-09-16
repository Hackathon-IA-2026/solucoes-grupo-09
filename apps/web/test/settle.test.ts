import { describe, expect, it } from "bun:test";
import { settleWith } from "../src/lib/settle";

/**
 * The guard that used to be written out fourteen times, and the one failure it
 * prevents.
 *
 * A `setState` that lands after its effect was torn down does not throw. It
 * writes an answer about a question the reader has already navigated away from
 * — a screen that flickers back to the previous subsystem a second after you
 * left it. That is why the four read hooks each checked `signal.aborted`
 * before every set, and why a forgotten check was invisible.
 */

describe("a settled value lands while the request is live", () => {
  it("applies before the abort", () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    settle("read");
    expect(seen).toEqual(["read"]);
  });

  it("applies more than once — a hook sets `reading` then the answer", () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    settle("reading");
    settle("read");
    expect(seen).toEqual(["reading", "read"]);
  });
});

describe("a settled value is dropped once the request is abandoned", () => {
  it("does nothing after abort", () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    controller.abort();
    settle("too late");
    expect(seen).toEqual([]);
  });

  it("drops every later call, not just the first", () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    controller.abort();
    settle("a");
    settle("b");
    expect(seen).toEqual([]);
  });

  it("the abort mid-flight is the real case: one lands, the next does not", () => {
    // Exactly the shape of a hook whose key changed while a request was open:
    // the `reading` state was already set, then the effect is torn down, then
    // the response arrives.
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    settle("reading");
    controller.abort();
    settle("read");
    expect(seen).toEqual(["reading"]);
  });

  it("reads the signal at call time, not at bind time", () => {
    // The whole mechanism depends on this: the binding is made *before* the
    // request starts and must see an abort that happens afterwards. A version
    // that captured `signal.aborted` when it was built would let every late
    // answer through.
    const controller = new AbortController();
    let landed = false;
    const settle = settleWith(controller.signal, () => {
      landed = true;
    });
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    settle(undefined as never);
    expect(landed).toBe(false);
  });
});

describe("it is a function of the signal, not of a shared flag", () => {
  it("two settlers on two controllers do not interfere", () => {
    const first = new AbortController();
    const second = new AbortController();
    const seen: string[] = [];
    const a = settleWith(first.signal, (v: string) => seen.push(`a:${v}`));
    const b = settleWith(second.signal, (v: string) => seen.push(`b:${v}`));
    first.abort();
    a("dropped");
    b("kept");
    expect(seen).toEqual(["b:kept"]);
  });
});
