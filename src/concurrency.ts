import { BusyError } from "./errors.js";

/**
 * A counting semaphore with a bounded wait queue. Each scrape launches a real
 * Chromium, so unbounded concurrency would OOM the host — this caps how many
 * run at once and rejects with `BusyError` (→ 503) once the queue is full,
 * instead of letting work pile up without limit.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new BusyError());
    }
    // We inherit the active slot from release(), so don't increment here —
    // that avoids an over-subscription race.
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  get stats(): { active: number; queued: number; max: number } {
    return { active: this.active, queued: this.waiters.length, max: this.max };
  }
}
