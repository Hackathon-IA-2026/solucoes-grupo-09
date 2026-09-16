/**
 * `WebAudioBackend.narrationClock`, which is what a briefing locks its scenes to.
 *
 * This class had no test at all, because it is browser-only and every method
 * before this one either touched a microphone or a socket. The clock is
 * different: it is arithmetic over two numbers the class already tracks, and it
 * is the number a scene change depends on, so it is worth the stub.
 *
 * The stub is deliberately thin — a clock that can be advanced by hand, and the
 * three factory methods `playChunk` calls. Anything more would be re-testing the
 * browser.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { encodePCM16Base64, SAMPLE_RATE } from "@/lib/voice/audio-codec";

/** One second of silence, so a chunk's duration is a round number. */
const ONE_SECOND = encodePCM16Base64(new Float32Array(SAMPLE_RATE));

/**
 * The thinnest context that `playChunk` can run against: a clock a test can
 * move by hand, plus the three factories it calls.
 *
 * The members are properties rather than methods so the fake carries no `this`
 * — it is a stand-in for a browser object, not a class with behaviour.
 */
class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = {};
  // biome-ignore lint/nursery/useThisInClassMethods: it stands in for a browser object whose factories take no instance state; `currentTime` above is the only field a test touches
  createBuffer = (_channels: number, length: number, sampleRate: number) => ({
    duration: length / sampleRate,
    getChannelData: () => new Float32Array(length),
  });
  // biome-ignore lint/nursery/useThisInClassMethods: same — a stub source, not behaviour
  createBufferSource = () => ({ buffer: null, connect: () => {}, start: () => {} });
  // biome-ignore lint/nursery/useThisInClassMethods: same — nothing to close
  close = () => Promise.resolve();
}

/** `globalThis` with the one slot this file replaces. */
interface AudioGlobal {
  AudioContext?: unknown;
}

const original = (globalThis as AudioGlobal).AudioContext;

beforeEach(() => {
  (globalThis as AudioGlobal).AudioContext = FakeAudioContext;
});

afterEach(() => {
  (globalThis as AudioGlobal).AudioContext = original;
});

async function backend() {
  const { WebAudioBackend } = await import("@/lib/voice/web-audio-backend");
  return new WebAudioBackend();
}

/**
 * The playback context the backend made for itself, so a test can move time.
 *
 * Reaching past `private` deliberately: the alternative is a seam on the class
 * that exists only for tests, and the clock is worth less than that would cost.
 */
function contextOf(instance: unknown): FakeAudioContext {
  return (instance as { playbackContext: FakeAudioContext }).playbackContext;
}

describe("before anything has played", () => {
  it("reads zero rather than guessing", async () => {
    // Zero is also what a blocked autoplay policy looks like, which is the
    // signal the director needs to fall back to a wall clock.
    expect((await backend()).narrationClock()).toEqual({
      elapsedMs: 0,
      bufferedMs: 0,
      running: false,
    });
  });
});

describe("while a response streams", () => {
  it("buffers ahead of what has played", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);

    // A second is queued; none of it has played yet.
    expect(audio.narrationClock()).toEqual({
      elapsedMs: 0,
      bufferedMs: 1000,
      running: true,
    });
  });

  it("advances elapsed with the context's own clock", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);
    contextOf(audio).currentTime = 0.4;

    const clock = audio.narrationClock();
    expect(clock.elapsedMs).toBeCloseTo(400, 5);
    expect(clock.bufferedMs).toBeCloseTo(1000, 5);
  });

  it("grows the buffer as more of the response arrives", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);
    audio.playChunk(ONE_SECOND);

    // Two seconds queued from one start — which is why a plan is fitted
    // continuously: the true narration length is not known until the end.
    expect(audio.narrationClock().bufferedMs).toBeCloseTo(2000, 5);
  });
});

describe("between responses", () => {
  it("starts a new run when the queue has drained", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);
    // The first second played out and the reader sat in silence for four more.
    contextOf(audio).currentTime = 5;
    audio.playChunk(ONE_SECOND);

    // The second response's elapsed time is its own, not five seconds in.
    expect(audio.narrationClock().elapsedMs).toBe(0);
    expect(audio.narrationClock().bufferedMs).toBeCloseTo(1000, 5);
  });

  it("drops the clock on barge-in", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);
    contextOf(audio).currentTime = 0.5;
    audio.endNarration();

    // The abandoned turn's elapsed time must not be inherited by the next one.
    expect(audio.narrationClock()).toEqual({
      elapsedMs: 0,
      bufferedMs: 0,
      running: false,
    });
  });

  it("keeps the queue intact across a barge-in, then reopens on the next chunk", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);
    audio.endNarration();
    contextOf(audio).currentTime = 0.25;
    audio.playChunk(ONE_SECOND);

    // Still mid-queue, so the new run is dated from where playback actually is.
    expect(audio.narrationClock().elapsedMs).toBe(0);
  });
});

describe("teardown", () => {
  it("leaves no clock behind", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);
    audio.teardown();

    expect(audio.narrationClock()).toEqual({
      elapsedMs: 0,
      bufferedMs: 0,
      running: false,
    });
  });
});

describe("when the narration has finished", () => {
  it("stops reporting a running clock once the queue has played out", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);
    // The second sounded, and the reader has been looking at the last scene
    // for nine more.
    contextOf(audio).currentTime = 10;

    // The context is still `"running"` — it always is — but there is nothing
    // left queued, and a finished narration is not a playing one.
    expect(audio.narrationClock().running).toBe(false);
  });

  it("is still running on the last frame, and not one after", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);

    contextOf(audio).currentTime = 0.999;
    expect(audio.narrationClock().running).toBe(true);
    contextOf(audio).currentTime = 1;
    expect(audio.narrationClock().running).toBe(false);
  });

  it("runs again when the next chunk of the same run arrives", async () => {
    const audio = await backend();
    audio.playChunk(ONE_SECOND);
    // The model paused mid-response for longer than it had buffered: playback
    // genuinely stopped, so the stage should hold rather than race ahead.
    contextOf(audio).currentTime = 1.5;
    expect(audio.narrationClock().running).toBe(false);

    audio.playChunk(ONE_SECOND);
    expect(audio.narrationClock().running).toBe(true);
  });
});
