import { describe, expect, it } from "bun:test";
import {
  base64ToBytes,
  bytesToBase64,
  decodePCM16Base64,
  encodePCM16Base64,
  levelFromFloat,
  resampleLinear,
  SAMPLE_RATE,
} from "@/lib/voice/audio-codec";

/**
 * The codec is vendored, so the tests are ours — that is the point of vendoring
 * rather than depending. Code copied into a repository with no tests of its own
 * is code nobody may change, and this module will be changed the first time a
 * browser disagrees about a buffer.
 */

describe("voice codec · PCM16 survives the round trip", () => {
  it("round-trips a signal within one quantisation step", () => {
    // 16-bit quantisation is 1/32768, so anything inside 2⁻¹⁵ is the format's
    // own floor rather than an error in this code.
    const samples = new Float32Array(512);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 440);
    }
    const back = decodePCM16Base64(encodePCM16Base64(samples));
    expect(back.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      expect(Math.abs((back[i] as number) - (samples[i] as number))).toBeLessThan(1 / 32000);
    }
  });

  it("clamps out-of-range samples rather than wrapping them", () => {
    // A wrap turns a loud sample into a loud sample of the opposite sign, which
    // is an audible click rather than a rounding error.
    const back = decodePCM16Base64(encodePCM16Base64(new Float32Array([2, -2, 1, -1])));
    expect(back[0]).toBeGreaterThan(0.99);
    expect(back[1]).toBeLessThan(-0.99);
    expect(back[2]).toBeGreaterThan(0.99);
    expect(back[3]).toBeLessThan(-0.99);
  });

  it("encodes an empty frame without producing an empty stream of garbage", () => {
    expect(encodePCM16Base64(new Float32Array(0))).toBe("");
    expect(decodePCM16Base64("").length).toBe(0);
  });
});

describe("voice codec · base64 is byte-correct", () => {
  it("agrees with the platform encoder on every byte value", () => {
    // Non-vacuity, and the reason this is hand-rolled at all: `btoa` operates
    // on code units and mangles anything above 0x7f, so a check against it has
    // to be done through a byte-preserving path — which is what `Buffer` is.
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) {
      bytes[i] = i;
    }
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect([...base64ToBytes(Buffer.from(bytes).toString("base64"))]).toEqual([...bytes]);
  });

  it("pads the two ragged lengths correctly", () => {
    for (const length of [1, 2, 3, 4, 5, 6, 7]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    }
  });

  it("ignores whitespace and newlines a transport may have inserted", () => {
    const encoded = bytesToBase64(Uint8Array.from([1, 2, 3, 4, 5]));
    const wrapped = `${encoded.slice(0, 4)}\n ${encoded.slice(4)}`;
    expect([...base64ToBytes(wrapped)]).toEqual([...base64ToBytes(encoded)]);
  });
});

describe("voice codec · the level meter is what the orb reacts to", () => {
  it("is zero for silence and one for a full-scale signal", () => {
    expect(levelFromFloat(new Float32Array(128))).toBe(0);
    expect(levelFromFloat(new Float32Array(128).fill(1))).toBe(1);
  });

  it("never leaves 0..1, whatever it is handed", () => {
    // It drives a width. A level above 1 is a ring drawn outside its own box.
    for (const fill of [-5, -1, 0.5, 3, 100]) {
      const level = levelFromFloat(new Float32Array(64).fill(fill));
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  it("puts ordinary speech in the visible part of the range", () => {
    // The ×6 is a calibration against human speech, not a magic number: speech
    // RMS is roughly 0.02–0.2. Without it a normal voice would move the orb by
    // a fifth of its travel and the interface would look dead while somebody
    // was talking into it.
    const quiet = levelFromFloat(new Float32Array(256).fill(0.02));
    const loud = levelFromFloat(new Float32Array(256).fill(0.2));
    expect(quiet).toBeGreaterThan(0.1);
    expect(loud).toBeGreaterThan(0.9);
  });

  it("is zero-length safe", () => {
    expect(levelFromFloat(new Float32Array(0))).toBe(0);
  });
});

describe("voice codec · resampling", () => {
  it("returns the input untouched when the rates match", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleLinear(input, SAMPLE_RATE, SAMPLE_RATE)).toBe(input);
  });

  it("halves the length going down an octave of rate, and keeps the shape", () => {
    const input = Float32Array.from({ length: 100 }, (_, i) => i / 100);
    const out = resampleLinear(input, 48_000, 24_000);
    expect(out.length).toBe(50);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[49]).toBeCloseTo(0.98, 2);
  });

  it("is empty-safe", () => {
    expect(resampleLinear(new Float32Array(0), 48_000, 24_000).length).toBe(0);
  });
});
