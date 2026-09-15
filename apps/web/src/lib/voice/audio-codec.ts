/**
 * PCM16 ↔ base64 ↔ Float32, and the level meter the orb is driven by.
 *
 * **Vendored from `EvanBacon/grok-voice-demo` (`src/utils/grok-voice-core.ts`),
 * deliberately and with the reasoning kept.** `docs/plans/voice-copilot.md` §1.1
 * settles what to take from that repository and what to leave: the transport
 * and the codecs are the asset, the UI is a ChatGPT shell we are not building.
 * These functions are the codec half, split into their own module here because
 * they are pure arithmetic over buffers and testable as such — the demo keeps
 * them beside the socket, where they cannot be.
 *
 * **Why hand-rolled base64 rather than `atob`/`btoa`.** The demo's reason is
 * Hermes, which has neither. Ours is narrower and still good: this module is
 * imported by code that runs under Bun's test runner as well as in a browser,
 * and a codec that depends on a DOM global is a codec whose tests need a DOM.
 * It is also correct on bytes rather than on code units, which `btoa` is not.
 */

/** The realtime API's sample rate. 24 kHz mono, both directions. */
export const SAMPLE_RATE = 24_000;

/**
 * Root-mean-square of a frame, boosted into a display-friendly 0..1 level.
 *
 * Drives the orb, and that is the whole of what makes the interface feel alive
 * rather than animated: the ring reacts to the reader's *actual voice*, not to
 * a loop. `docs/plans/voice-copilot.md` §5.1 — the futurism is in the
 * responsiveness, not in the decoration.
 *
 * The ×6 is the demo's, and its comment explains it: speech RMS is roughly
 * 0.02–0.2, so a normal speaking voice should fill the meter rather than nudge
 * it. Kept rather than re-derived, because it is a calibration against human
 * speech and not a magic number.
 */
export function levelFromFloat(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] as number;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.max(0, Math.min(1, rms * 6));
}

/** Linear-resample mono Float32 audio from `inRate` to `outRate`. */
export function resampleLinear(
  input: Float32Array,
  inRate: number,
  outRate: number,
): Float32Array {
  if (inRate === outRate || input.length === 0) {
    return input;
  }
  const ratio = inRate / outRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let index = 0; index < outLength; index += 1) {
    const position = index * ratio;
    const lower = Math.floor(position);
    const fraction = position - lower;
    const a = input[lower] as number;
    const b = lower + 1 < input.length ? (input[lower + 1] as number) : a;
    output[index] = a + (b - a) * fraction;
  }
  return output;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] as number;
    const b1 = index + 1 < bytes.length ? (bytes[index + 1] as number) : 0;
    const b2 = index + 2 < bytes.length ? (bytes[index + 2] as number) : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += index + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += index + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const length = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(length);
  let position = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const c0 = B64.indexOf(clean[index] as string);
    const c1 = B64.indexOf(clean[index + 1] as string);
    const c2 = B64.indexOf(clean[index + 2] as string);
    const c3 = B64.indexOf(clean[index + 3] as string);
    if (position < length) {
      bytes[position++] = (c0 << 2) | (c1 >> 4);
    }
    if (position < length && c2 >= 0) {
      bytes[position++] = ((c1 & 15) << 4) | (c2 >> 2);
    }
    if (position < length && c3 >= 0) {
      bytes[position++] = ((c2 & 3) << 6) | c3;
    }
  }
  return bytes;
}

/** Float32 samples (−1..1) → base64-encoded little-endian PCM16. */
export function encodePCM16Base64(float32: Float32Array): string {
  const bytes = new Uint8Array(float32.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < float32.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, float32[index] as number));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x80_00 : clamped * 0x7f_ff, true);
  }
  return bytesToBase64(bytes);
}

/** base64-encoded little-endian PCM16 → Float32 samples (−1..1). */
export function decodePCM16Base64(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const float32 = new Float32Array(Math.floor(bytes.length / 2));
  for (let index = 0; index < float32.length; index += 1) {
    const int16 = view.getInt16(index * 2, true);
    float32[index] = int16 / (int16 < 0 ? 0x80_00 : 0x7f_ff);
  }
  return float32;
}
