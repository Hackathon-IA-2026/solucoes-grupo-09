import { describe, expect, it } from "bun:test";
import type { ToolCall } from "../src/lib/voice/execute";
import {
  type AudioBackend,
  type MintedSession,
  type TranscriptEntry,
  VoiceSessionCore,
  type VoiceStatus,
} from "../src/lib/voice/session";

/**
 * **`VoiceSessionCore`, driven without a gateway, a socket or a microphone.**
 *
 * The class was at 14% function coverage — 250 of its 374 lines untested — and
 * that is the more surprising half of the finding, because it was *built* to be
 * tested. Every dependency is already injected and `VoiceSessionConfig` says so
 * in as many words: *"Injected so the session is testable without a gateway."*
 * The seam was there and nothing walked through it; only the two pure exports,
 * `toolCallFrom` and `realtimeUrl`, had tests.
 *
 * What that left uncovered is the protocol, and protocol bugs are the quiet
 * kind. A transcript that opens a new entry per delta does not throw — it fills
 * the panel with one word per row. A status that never leaves `thinking` does
 * not throw either; the orb simply stops meaning anything. Neither is visible
 * to a type checker and neither reaches an end-to-end test that does not have a
 * real conversation in it.
 */

const MINTED: MintedSession = {
  clientSecret: "ephemeral-secret",
  expiresAt: "2026-09-15T12:10:00.000Z",
  model: "grok-realtime",
  voice: "ara",
};

/** A socket that records what was written and lets a test speak back. */
class FakeSocket {
  readonly sent: Record<string, unknown>[] = [];
  /**
   * `OPEN`, because `send()` guards on it.
   *
   * The first version of this fake had no `readyState` and five tests failed
   * with an empty `sent` array — which is the guard working: the class refuses
   * to write to a socket that is not open, so a frame queued during connect or
   * after close is dropped rather than throwing. Worth stating, because a fake
   * that omits the field would have made those five tests pass for the wrong
   * reason if the guard were ever removed.
   */
  readyState = 1;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  /** One frame from the service, as it would actually arrive: a JSON string. */
  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The `session.update` handshake, which is always the first thing written. */
  get handshake(): Record<string, unknown> {
    const first = this.sent[0];
    return (first?.session ?? {}) as Record<string, unknown>;
  }
}

interface Harness {
  session: VoiceSessionCore;
  socket: FakeSocket;
  statuses: VoiceStatus[];
  transcript: TranscriptEntry[];
  calls: ToolCall[];
  errors: string[];
  levels: number[];
  captureStarted: () => boolean;
  tornDown: () => boolean;
  /** Feed the capture callbacks the backend was handed. */
  speak: (base64: string, level: number) => void;
}

function harness(
  options: { mint?: () => Promise<MintedSession>; captureFails?: string } = {},
): Harness {
  const socket = new FakeSocket();
  const statuses: VoiceStatus[] = [];
  const transcript: TranscriptEntry[] = [];
  const calls: ToolCall[] = [];
  const errors: string[] = [];
  const levels: number[] = [];
  let started = false;
  let torn = false;
  let onChunk: ((base64: string) => void) | null = null;
  let onLevel: ((level: number) => void) | null = null;

  const backend: AudioBackend = {
    openSocket: () => socket as unknown as WebSocket,
    startCapture: async (chunk, level) => {
      if (options.captureFails !== undefined) {
        throw new Error(options.captureFails);
      }
      started = true;
      onChunk = chunk;
      onLevel = level;
    },
    playChunk: () => {},
    teardown: () => {
      torn = true;
    },
  };

  const session = new VoiceSessionCore(
    {
      onStatus: (status) => statuses.push(status),
      onTranscript: (entry) => transcript.push(entry),
      onToolCall: (call) => calls.push(call),
      onError: (message) => errors.push(message),
      onLevel: (level) => levels.push(level),
    },
    backend,
    {
      mint: options.mint ?? (async () => MINTED),
      instructions: "THE STANDING RULES",
      tools: [{ name: "show_grid" }],
    },
  );

  return {
    session,
    socket,
    statuses,
    transcript,
    calls,
    errors,
    levels,
    captureStarted: () => started,
    tornDown: () => torn,
    speak: (base64, level) => {
      onChunk?.(base64);
      onLevel?.(level);
    },
  };
}

/** Start and let the socket open, which is what a real connection does. */
async function connected(options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = harness(options);
  await h.session.start();
  await h.socket.onopen?.();
  return h;
}

describe("the handshake states the contract before a word is spoken", () => {
  it("sends the instructions and the tool schema it was configured with", async () => {
    const h = await connected();
    expect(h.socket.sent[0]?.type).toBe("session.update");
    expect(h.socket.handshake.instructions).toBe("THE STANDING RULES");
    expect(h.socket.handshake.tools).toEqual([{ name: "show_grid" }]);
    expect(h.socket.handshake.voice).toBe("ara");
  });

  it("asks for server turn detection and echo filtering, both of which are load-bearing", () => {
    // `docs/plans/voice-copilot.md` §8 lists "the voice talks over the reader"
    // as a named risk and both of these as its mitigation. On a dashboard the
    // speaker and the microphone are a foot apart; without the filter the agent
    // answers its own voice.
    return connected().then((h) => {
      expect(h.socket.handshake.turn_detection).toEqual({ type: "server_vad" });
      expect(h.socket.handshake.enable_echo_detection_filtering).toBe(true);
      expect(h.socket.handshake.input_audio_transcription).toEqual({ enabled: true });
    });
  });

  it("reaches `listening` only once the microphone is actually open", async () => {
    const h = await connected();
    // `connecting` on start, `listening` after `startCapture` resolved — and
    // not before, because reaching `listening` is the only proof the microphone
    // opened at all.
    expect(h.statuses).toEqual(["connecting", "listening"]);
    expect(h.captureStarted()).toBe(true);
  });

  it("forwards captured audio and level frames to the socket and the handler", async () => {
    const h = await connected();
    h.speak("AAAA", 0.4);
    const appended = h.socket.sent.find((m) => m.type === "input_audio_buffer.append");
    expect(appended?.audio).toBe("AAAA");
    expect(h.levels).toEqual([0.4]);
  });
});

describe("a microphone that never opens is reported, not thrown", () => {
  it("fails with the denial's own message and opens no capture", async () => {
    const h = await connected({ captureFails: "Permission denied" });
    expect(h.errors).toEqual(["Permission denied"]);
    expect(h.captureStarted()).toBe(false);
    // The dock turns this into the typed fallback, which is a working product —
    // so the session must not be left claiming to listen.
    expect(h.statuses).not.toContain("listening");
  });

  it("a mint that refuses is the same shape of failure", async () => {
    const h = harness({
      mint: async () => {
        throw new Error("VOICE_UNAVAILABLE");
      },
    });
    await h.session.start();
    expect(h.errors).toEqual(["VOICE_UNAVAILABLE"]);
    expect(h.socket.sent).toEqual([]);
  });
});

describe("the reader who closes the dock mid-mint gets no live microphone", () => {
  /**
   * The race the class carries a comment about and no test: `stop()` lands
   * while the credential is still in flight. Opening the socket then is *"a
   * live microphone behind a closed panel"* — the failure a reader cannot see
   * and would be right to be angry about.
   */
  it("a stop during the mint opens no socket at all", async () => {
    let release: (value: MintedSession) => void = () => {};
    const pending = new Promise<MintedSession>((resolve) => {
      release = resolve;
    });
    const h = harness({ mint: () => pending });
    const starting = h.session.start();
    h.session.stop();
    release(MINTED);
    await starting;

    expect(h.socket.sent).toEqual([]);
    expect(h.captureStarted()).toBe(false);
    expect(h.tornDown()).toBe(true);
  });
});

describe("the assistant's line streams into one entry, not one per word", () => {
  it("accumulates deltas under a single id", async () => {
    const h = await connected();
    h.socket.deliver({ type: "response.created", response_id: "r1" });
    h.socket.deliver({
      type: "response.audio_transcript.delta",
      response_id: "r1",
      delta: "O Nordeste ",
    });
    h.socket.deliver({
      type: "response.audio_transcript.delta",
      response_id: "r1",
      delta: "tem risco alto.",
    });

    const assistant = h.transcript.filter((entry) => entry.role === "assistant");
    // Two emissions, one *entry*: the id is stable and the text grows. A new id
    // per delta is the defect this is written against — it does not throw, it
    // fills the panel with one word per row.
    expect(new Set(assistant.map((entry) => entry.id)).size).toBe(1);
    expect(assistant.at(-1)?.text).toBe("O Nordeste tem risco alto.");
  });

  it("the done frame's transcript wins over the buffer, and closes the turn", async () => {
    const h = await connected();
    h.socket.deliver({
      type: "response.audio_transcript.delta",
      response_id: "r1",
      delta: "partial",
    });
    h.socket.deliver({
      type: "response.audio_transcript.done",
      response_id: "r1",
      transcript: "the whole sentence",
    });
    expect(h.transcript.at(-1)?.text).toBe("the whole sentence");

    // And the next turn is a *different* entry, or two answers merge into one.
    h.socket.deliver({
      type: "response.audio_transcript.delta",
      response_id: "r2",
      delta: "second answer",
    });
    const ids = new Set(
      h.transcript.filter((entry) => entry.role === "assistant").map((e) => e.id),
    );
    expect(ids.size).toBe(2);
  });

  it("a turn with no id at all still gets a distinct one", async () => {
    const h = await connected();
    h.socket.deliver({ type: "response.audio_transcript.delta", delta: "one" });
    h.socket.deliver({ type: "response.audio_transcript.done" });
    h.socket.deliver({ type: "response.audio_transcript.delta", delta: "two" });
    const ids = h.transcript.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id !== "")).toBe(true);
  });

  it("the reader's own speech arrives as a user entry", async () => {
    const h = await connected();
    h.socket.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "qual região devo me preocupar?",
    });
    const user = h.transcript.filter((entry) => entry.role === "user");
    expect(user).toHaveLength(1);
    expect(user[0]?.text).toBe("qual região devo me preocupar?");
  });

  it("an empty transcription is not an entry", async () => {
    const h = await connected();
    h.socket.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "",
    });
    expect(h.transcript.filter((entry) => entry.role === "user")).toEqual([]);
  });
});

describe("tool calls reach the handler, in both frame shapes", () => {
  it("the bare arguments-done frame", async () => {
    const h = await connected();
    h.socket.deliver({
      type: "response.function_call_arguments.done",
      name: "explain",
      call_id: "c1",
      arguments: '{"subsystem":"NE"}',
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.name).toBe("explain");
    expect(h.calls[0]?.callId).toBe("c1");
  });

  it("the wrapped output-item frame", async () => {
    const h = await connected();
    h.socket.deliver({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "show_grid",
        call_id: "c2",
        arguments: "{}",
      },
    });
    expect(h.calls.map((call) => call.name)).toEqual(["show_grid"]);
  });

  it("a frame that is not a tool call reaches nobody", async () => {
    const h = await connected();
    h.socket.deliver({
      type: "response.output_item.done",
      item: { type: "message", name: "not_a_tool" },
    });
    expect(h.calls).toEqual([]);
  });

  it("answering the model writes a function_call_output the socket can carry", async () => {
    const h = await connected();
    h.session.respondToTool("c1", "opened Explain");
    const answer = h.socket.sent.find((m) => m.type === "conversation.item.create") as
      | { item?: Record<string, unknown> }
      | undefined;
    expect(answer?.item?.type).toBe("function_call_output");
    expect(answer?.item?.call_id).toBe("c1");
    expect(answer?.item?.output).toBe("opened Explain");
  });

  it("updating the context rewrites the instructions, and nothing else", async () => {
    const h = await connected();
    h.session.updateContext("THE READER IS ON EXPLICAR");
    const update = h.socket.sent.filter((m) => m.type === "session.update").at(-1) as
      | { session?: Record<string, unknown> }
      | undefined;
    expect(update?.session?.instructions).toBe("THE READER IS ON EXPLICAR");
    // Not a second handshake: re-sending the tools or the voice mid-session
    // would be a different statement about what the session *is*.
    expect(Object.keys(update?.session ?? {})).toEqual(["instructions"]);
  });
});

describe("an error frame becomes a sentence, whatever shape it arrives in", () => {
  it("uses the service's own message when there is one", async () => {
    const h = await connected();
    h.socket.deliver({ type: "error", error: { message: "rate limited" } });
    expect(h.errors).toContain("rate limited");
  });

  it("falls back to a sentence rather than rendering `undefined`", async () => {
    const h = await connected();
    h.socket.deliver({ type: "error", error: {} });
    expect(h.errors.at(-1)).toBe("The voice service reported an error.");
    expect(h.errors.at(-1)).not.toContain("undefined");
  });

  it("a frame that is not JSON at all is survived", async () => {
    const h = await connected();
    // The handler is a socket callback mid-conversation; a throw there ends the
    // session rather than the frame.
    expect(() => h.socket.onmessage?.({ data: "<html>502</html>" })).not.toThrow();
    expect(() => h.socket.onmessage?.({ data: "null" })).not.toThrow();
  });

  it("a transport error is reported through the same path", async () => {
    const h = await connected();
    h.socket.onerror?.();
    expect(h.errors).toContain("The voice connection failed.");
  });
});

describe("stop closes everything it opened", () => {
  it("tears down the backend and closes the socket", async () => {
    const h = await connected();
    h.session.stop();
    expect(h.tornDown()).toBe(true);
    expect(h.socket.closed).toBe(true);
  });

  it("is safe twice — the dock can close a session that already closed", async () => {
    const h = await connected();
    h.session.stop();
    expect(() => h.session.stop()).not.toThrow();
  });

  it("drops the half-built assistant line, so a reopened dock starts clean", async () => {
    const h = await connected();
    h.socket.deliver({
      type: "response.audio_transcript.delta",
      response_id: "r1",
      delta: "half a sen",
    });
    h.session.stop();
    const before = h.transcript.length;
    // Nothing further is emitted from the buffer that was discarded.
    h.socket.deliver({
      type: "response.audio_transcript.done",
      response_id: "r1",
    });
    expect(h.transcript.length).toBe(before);
  });
});

describe("a typed line is a turn the model answers, not a note it reads", () => {
  /**
   * The plan's §10.5, closed. `say` used to push the text in as *context*, so
   * the agent knew what had been typed and had no reason to reply — a reader
   * without a microphone could be heard and not answered, which is half an
   * interface.
   */
  it("creates a user message item carrying the text", async () => {
    const h = await connected();
    h.session.sayAsUser("qual região devo me preocupar?");
    const item = h.socket.sent.find((m) => m.type === "conversation.item.create") as
      | { item?: Record<string, unknown> }
      | undefined;
    expect(item?.item?.type).toBe("message");
    expect(item?.item?.role).toBe("user");
    expect(item?.item?.content).toEqual([
      { type: "input_text", text: "qual região devo me preocupar?" },
    ]);
  });

  it("asks for a response — without which the item lands and nothing speaks", () => {
    // The half that makes it a turn. Sending only the item is the old
    // behaviour wearing a better name, and it fails silently: the
    // conversation grows and the dock stays quiet.
    return connected().then((h) => {
      h.session.sayAsUser("e se eu tivesse uma bateria?");
      const order = h.socket.sent.map((m) => m.type);
      const create = order.lastIndexOf("conversation.item.create");
      const respond = order.lastIndexOf("response.create");
      expect(create).toBeGreaterThanOrEqual(0);
      expect(respond).toBeGreaterThan(create);
    });
  });

  it("is the same two-frame shape `respondToTool` uses", async () => {
    // Deliberately, so there is one way of creating an item and asking for an
    // answer rather than two to keep in step with the protocol.
    const h = await connected();
    h.session.respondToTool("c1", "opened Explain");
    const afterTool = h.socket.sent.length;
    h.session.sayAsUser("por quê?");
    const frames = h.socket.sent.slice(afterTool).map((m) => m.type);
    expect(frames).toEqual(["conversation.item.create", "response.create"]);
  });

  it("does nothing on a closed socket, like every other send", async () => {
    const h = await connected();
    h.session.stop();
    const before = h.socket.sent.length;
    expect(() => h.session.sayAsUser("too late")).not.toThrow();
    expect(h.socket.sent.length).toBe(before);
  });
});
