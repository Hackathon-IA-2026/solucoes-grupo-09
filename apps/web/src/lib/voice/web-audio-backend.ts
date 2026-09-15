import {
  decodePCM16Base64,
  encodePCM16Base64,
  levelFromFloat,
  SAMPLE_RATE,
} from "./audio-codec";
import type { AudioBackend } from "./session";

/**
 * The browser's half of the voice session: a microphone, a speaker, and a socket.
 *
 * **Vendored from `EvanBacon/grok-voice-demo` (`src/utils/grok-voice.ts`).**
 * `docs/plans/voice-copilot.md` §1.1 marks this one "take nearly whole", and the
 * three decisions inside it are all worth keeping for reasons the demo states
 * and this comment does not improve on:
 *
 *  - **`getUserMedia` with `echoCancellation`.** The reader's speaker and
 *    microphone are a foot apart on a laptop. Without AEC the agent hears itself
 *    and answers its own last sentence.
 *  - **An `AudioWorklet`, inlined as a Blob.** The worklet runs on the audio
 *    thread rather than the main one, so a busy dashboard cannot stutter the
 *    capture; inlining it means there is no separate static asset for the export
 *    to serve, which matters because `apps/web` is a static export and every
 *    extra file is a path that has to exist on the CDN.
 *  - **A `playCursor` rather than playing each chunk on arrival.** Scheduling
 *    each buffer at the end of the last is what makes streamed speech continuous
 *    instead of a sequence of clicks.
 *
 * **The subprotocol is not a trick, it is the only door.** A browser cannot set
 * an `Authorization` header on a WebSocket, so the ephemeral credential travels
 * in `Sec-WebSocket-Protocol`. That is also precisely why the credential must be
 * ephemeral and why `apps/api` mints it — a place a header cannot reach is a
 * place a long-lived key must never be put.
 */

/**
 * The capture worklet. Forwards raw mic frames to the main thread and does
 * nothing else — every decision about them is made on the other side.
 */
const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('wattsteer-capture', CaptureProcessor);
`;

export class WebAudioBackend implements AudioBackend {
  private micStream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private playbackContext: AudioContext | null = null;
  private playCursor = 0;
  private onLevel: ((level: number) => void) | null = null;

  openSocket(url: string, clientSecret: string): WebSocket {
    return new WebSocket(url, [`xai-client-secret.${clientSecret}`]);
  }

  async startCapture(
    onChunk: (base64: string) => void,
    onLevel: (level: number) => void,
  ): Promise<void> {
    this.onLevel = onLevel;
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.captureContext = context;
    const blobUrl = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: "application/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(blobUrl);
    } finally {
      // Revoked in a `finally` rather than after the await: a module that fails
      // to load still leaves the object URL holding its Blob for the life of the
      // document, and this path runs every time a reader opens the dock.
      URL.revokeObjectURL(blobUrl);
    }

    const source = context.createMediaStreamSource(this.micStream);
    const node = new AudioWorkletNode(context, "wattsteer-capture");
    this.captureNode = node;
    node.port.onmessage = (event: MessageEvent) => {
      const frame = event.data as Float32Array;
      onLevel(levelFromFloat(frame));
      onChunk(encodePCM16Base64(frame));
    };
    source.connect(node);
    // Connected to the destination so the graph keeps pulling frames. It routes
    // no audio: the worklet emits nothing downstream, so the microphone is not
    // fed back to the speaker.
    node.connect(context.destination);
  }

  playChunk(base64: string): void {
    this.playbackContext ??= new AudioContext({ sampleRate: SAMPLE_RATE });
    const context = this.playbackContext;
    const float32 = decodePCM16Base64(base64);
    if (float32.length === 0) {
      return;
    }
    // The same meter drives the orb while the agent speaks as while the reader
    // does, so the ring is always showing whoever currently has the floor.
    this.onLevel?.(levelFromFloat(float32));

    const buffer = context.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const now = context.currentTime;
    if (this.playCursor < now) {
      this.playCursor = now;
    }
    source.start(this.playCursor);
    this.playCursor += buffer.duration;
  }

  teardown(): void {
    this.captureNode?.disconnect();
    this.captureNode = null;
    void this.captureContext?.close().catch(() => {});
    this.captureContext = null;
    // Every track, explicitly: a `MediaStream` left running is the browser's
    // recording indicator staying lit after the reader closed the panel, which
    // is the single most alarming thing this feature could do.
    for (const track of this.micStream?.getTracks() ?? []) {
      track.stop();
    }
    this.micStream = null;
    void this.playbackContext?.close().catch(() => {});
    this.playbackContext = null;
    this.playCursor = 0;
    this.onLevel = null;
  }
}
