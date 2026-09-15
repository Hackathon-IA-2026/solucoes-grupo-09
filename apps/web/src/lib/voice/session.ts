import type { ToolCall } from "./tools";

/**
 * The realtime session: socket lifecycle and the event protocol, and nothing
 * platform-specific.
 *
 * **Vendored from `EvanBacon/grok-voice-demo` and then extended where it stops
 * short.** `docs/plans/voice-copilot.md` §1.1 records what was worth taking from
 * that repository — this class's shape, the `AudioBackend` seam, the
 * `session.update` handshake — and §1.3 records the gap:
 *
 * > **The demo has no tool calling.** Its `handleMessage` switch handles audio
 * > deltas, transcripts and errors — and nothing else. It is a talking head: it
 * > can answer, it cannot *act*.
 *
 * Everything that makes the WattSteer copilot more than a chat bubble lives in
 * that gap, so this class adds three things and changes nothing else:
 *
 *  1. **Tools** are declared in the handshake and their calls are surfaced on
 *     `onToolCall`. This class does not execute them — it does not know what a
 *     subsystem is. `execute.ts` turns a call into an intent and the provider
 *     performs it, which is what keeps the agent's behaviour testable with no
 *     socket in the room.
 *  2. **`thinking` and `acting`** join the status union. Without `thinking` the
 *     orb sits on "listening" through the model's latency, and the interface
 *     feels dead at exactly the moment the reader is waiting hardest. `acting`
 *     is the state where the dock says what it is opening while the screen
 *     changes behind it — naming it is what stops a navigation reading as a
 *     glitch.
 *  3. **The credential comes from our own gateway**, not from a bundled API
 *     route: `apps/web` is a static export with no server-side runtime, so
 *     there is one process in this system that can hold a key and it is
 *     `apps/api`. See `docs/plans/voice-copilot.md` §2.1.
 */

/** The realtime endpoint. The model travels in the query string. */
export function realtimeUrl(model: string): string {
  return `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`;
}

/**
 * What the dock is showing, and why there are seven rather than the demo's five.
 *
 * `thinking` and `acting` are WattSteer's — see the class comment. The other
 * five are the demo's and mean what they say there.
 */
export type VoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "acting"
  | "error";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface VoiceHandlers {
  onStatus?: (status: VoiceStatus) => void;
  onTranscript?: (entry: TranscriptEntry) => void;
  onToolCall?: (call: ToolCall) => void;
  onError?: (message: string) => void;
  /** Normalised 0..1 level — mic while listening, playback while speaking. */
  onLevel?: (level: number) => void;
}

/**
 * The platform's audio and transport layer, which this class drives.
 *
 * Kept as a seam even though only the web implements it, because
 * `docs/plans/voice-copilot.md` §9 says native is deferred rather than refused —
 * and a seam costs one interface now against a rewrite later.
 */
export interface AudioBackend {
  openSocket: (url: string, clientSecret: string) => WebSocket;
  startCapture: (
    onChunk: (base64Pcm16: string) => void,
    onLevel: (level: number) => void,
  ) => Promise<void>;
  playChunk: (base64Pcm16: string) => void;
  teardown: () => void;
}

/** What `GET /v1/voice/session` answers. Mirrors `apps/api/src/api/voice.ts`. */
export interface MintedSession {
  clientSecret: string;
  expiresAt: string;
  model: string;
  voice: string;
}

export interface VoiceSessionConfig {
  /** Mints a credential. Injected so the session is testable without a gateway. */
  mint: () => Promise<MintedSession>;
  /** The system prompt for the reader's locale. */
  instructions: string;
  /** The tool schema. Declared in the handshake; calls come back on `onToolCall`. */
  tools: readonly unknown[];
}

export class VoiceSessionCore {
  private socket: WebSocket | null = null;
  private assistantBuffer = "";
  private assistantId: string | null = null;
  private turn = 0;
  private stopped = false;

  constructor(
    private readonly handlers: VoiceHandlers,
    private readonly backend: AudioBackend,
    private readonly config: VoiceSessionConfig,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.setStatus("connecting");
    try {
      const minted = await this.config.mint();
      if (this.stopped) {
        // The reader closed the dock while the credential was in flight. Opening
        // a socket now would be a live microphone behind a closed panel.
        return;
      }
      const socket = this.backend.openSocket(
        realtimeUrl(minted.model),
        minted.clientSecret,
      );
      this.socket = socket;

      socket.onopen = async () => {
        this.send({
          type: "session.update",
          session: {
            voice: minted.voice,
            instructions: this.config.instructions,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: { type: "server_vad" },
            input_audio_transcription: { enabled: true },
            // Server-side filter: drop transcribed input matching what the
            // agent just said, so it does not answer its own echoed voice. Kept
            // from the demo — on a dashboard the speaker and the microphone are
            // a foot apart and this is not optional.
            enable_echo_detection_filtering: true,
            tools: this.config.tools,
          },
        });
        try {
          await this.backend.startCapture(
            (base64) => this.send({ type: "input_audio_buffer.append", audio: base64 }),
            (level) => this.handlers.onLevel?.(level),
          );
          this.setStatus("listening");
        } catch (error) {
          // A denied microphone lands here, and it is the most common failure
          // this class has. It is reported rather than thrown: the dock turns it
          // into the typed fallback, which is a working product.
          this.fail(error instanceof Error ? error.message : String(error));
        }
      };
      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => this.fail("The voice connection failed.");
      socket.onclose = () => {
        if (this.socket === socket) {
          this.stop();
        }
      };
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private handleMessage(event: MessageEvent): void {
    let message: Record<string, unknown>;
    try {
      const raw = typeof event.data === "string" ? event.data : "";
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      // A frame we cannot parse is dropped rather than thrown on. The socket is
      // a stream of many event types and an unknown one is not an error.
      return;
    }

    switch (message.type) {
      case "response.created":
        // The model has taken the turn but no audio exists yet. This is the
        // whole reason `thinking` is a status: without it the orb reads as
        // "still listening" while the reader waits.
        this.setStatus("thinking");
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (typeof message.delta === "string") {
          this.setStatus("speaking");
          this.backend.playChunk(message.delta);
        }
        break;
      case "response.output_audio.done":
      case "response.audio.done":
        this.setStatus("listening");
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof message.transcript === "string" && message.transcript !== "") {
          this.emit("user", message.transcript, asId(message.item_id));
        }
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        // Stream the assistant's line in as it is spoken, updating one entry
        // rather than appending many.
        if (this.assistantId === null) {
          this.assistantId =
            asId(message.response_id) ?? asId(message.item_id) ?? `assistant-${this.turn++}`;
        }
        this.assistantBuffer += typeof message.delta === "string" ? message.delta : "";
        if (this.assistantBuffer !== "") {
          this.emit("assistant", this.assistantBuffer, this.assistantId);
        }
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const text =
          typeof message.transcript === "string" ? message.transcript : this.assistantBuffer;
        if (text !== "") {
          this.emit("assistant", text, this.assistantId ?? asId(message.response_id));
        }
        this.assistantBuffer = "";
        this.assistantId = null;
        break;
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        // **The half the demo does not have.** A tool call is surfaced and not
        // executed: this class knows nothing about subsystems or routes, and
        // keeping it that way is what lets `execute.ts` be tested as arithmetic.
        const call = toolCallFrom(message);
        if (call !== null) {
          this.setStatus("acting");
          this.handlers.onToolCall?.(call);
        }
        break;
      }
      case "error":
        this.fail(errorMessageFrom(message));
        break;
      default:
        break;
    }
  }

  /**
   * Answer a tool call, so the model knows what happened and can speak about it.
   *
   * Without this the model has asked a question the conversation never answers,
   * and its next turn is built on a gap. The result is deliberately terse — the
   * screen is the real output, and a paragraph here would invite the model to
   * narrate what the reader can already see.
   */
  respondToTool(callId: string, result: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: result },
    });
    this.send({ type: "response.create" });
  }

  /** Push the reader's current screen into the session, between turns. */
  updateContext(context: string): void {
    this.send({ type: "session.update", session: { instructions: context } });
  }

  private emit(role: "user" | "assistant", text: string, id: string | null | undefined): void {
    this.handlers.onTranscript?.({
      id: id ?? `${role}-${text.slice(0, 12)}`,
      role,
      text,
    });
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private setStatus(status: VoiceStatus): void {
    this.handlers.onStatus?.(status);
  }

  private fail(message: string): void {
    this.setStatus("error");
    this.handlers.onError?.(message);
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.backend.teardown();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.assistantBuffer = "";
    this.assistantId = null;
  }
}

function asId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function errorMessageFrom(message: Record<string, unknown>): string {
  const error = message.error;
  if (typeof error === "object" && error !== null) {
    const text = (error as Record<string, unknown>).message;
    if (typeof text === "string" && text !== "") {
      return text;
    }
  }
  return "The voice service reported an error.";
}

/**
 * Pull a tool call out of a realtime frame, or `null` if it is not one.
 *
 * Two frame shapes, because the API has used both: a bare
 * `response.function_call_arguments.done`, and a `response.output_item.done`
 * wrapping an item of type `function_call`. Accepting both is the same defensive
 * posture `apps/api/src/api/voice.ts` takes over the minted secret's shape, and
 * for the same reason — the shape has not proved contractual.
 *
 * **Arguments are parsed, never trusted.** A call whose arguments are not an
 * object is surfaced with empty arguments rather than dropped, so `execute.ts`
 * refuses it out loud instead of the reader watching a tool silently do nothing.
 */
export function toolCallFrom(message: Record<string, unknown>): ToolCall | null {
  const item = message.item;
  const wrapped =
    typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
  if (wrapped !== null && wrapped.type !== "function_call") {
    return null;
  }
  const source = wrapped ?? message;
  const name = source.name;
  if (typeof name !== "string" || name === "") {
    return null;
  }
  const callId = source.call_id ?? source.id ?? message.call_id;
  const raw = source.arguments;
  let args: Record<string, unknown> = {};
  if (typeof raw === "string" && raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Left empty on purpose. `execute.ts` refuses a call it cannot satisfy,
      // and a spoken refusal is a better outcome than a dropped frame.
    }
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    args = raw as Record<string, unknown>;
  }
  return {
    id: typeof callId === "string" ? callId : "",
    name,
    arguments: args,
  };
}
