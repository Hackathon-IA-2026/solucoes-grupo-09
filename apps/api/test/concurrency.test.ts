import { describe, expect, it } from "bun:test";
import { Semaphore } from "../src/concurrency.js";
import { BusyError } from "../src/errors.js";

const defer = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Semaphore", () => {
  it("never runs more than `max` tasks at once", async () => {
    const sem = new Semaphore(2, 10);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await defer(15);
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => sem.run(task)));
    expect(peak).toBe(2);
  });

  it("rejects with BusyError when the queue is full", async () => {
    const sem = new Semaphore(1, 0);
    const busy = sem.run(() => defer(50)); // occupies the only slot
    expect(sem.run(async () => "x")).rejects.toBeInstanceOf(BusyError);
    await busy;
  });

  it("queues up to maxQueue and eventually runs all of it", async () => {
    const sem = new Semaphore(1, 5);
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        sem.run(async () => {
          await defer(3);
          done.push(i);
        }),
      ),
    );
    expect(done.sort()).toEqual([0, 1, 2, 3]);
  });

  it("reports stats", () => {
    expect(new Semaphore(3, 5).stats).toEqual({ active: 0, queued: 0, max: 3 });
  });
});
