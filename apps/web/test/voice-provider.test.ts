import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dockSizeFor,
  isLive,
  performIntent,
  REMINT_MARGIN_MS,
  remintDelayMs,
  toolResult,
  VOICE_ABSENT,
  type VoiceNavigator,
} from "../src/components/voice/use-voice-agent";
import type { NavigationIntent } from "../src/lib/voice/execute";
import { TOOL_REFUSAL_CODES } from "../src/lib/voice/execute";

/**
 * The provider — where it sits, and what it does with a tool call.
 *
 * Two kinds of assertion here, and the split is the same one
 * `wired-screens.test.ts` makes.
 *
 *  - **Behavioural**, over the pure decisions the provider makes: an intent is
 *    performed through a four-method port, and a test can supply a port that
 *    records. `highlight` not navigating is the property `docs/plans/voice-copilot.md`
 *    §6 step 1 calls the one that proves the thesis, and it is asserted by
 *    calling the code, not by reading it.
 *  - **Structural**, over the layout's own source, for the things that are true
 *    of a *tree* and have no function to call: the provider wraps the `Stack`,
 *    the dock is a sibling of it, both are inside `ServingProvider`, and none of
 *    it is at the root. Those are §2.2's non-negotiables and every one of them
 *    has a cheap way to stop being true — a session that dies on every
 *    navigation is a feature that breaks exactly when it works, and it breaks
 *    silently.
 *
 * Every guard below was checked by reintroducing the defect and watching the
 * named test fail. The list is in the ticket.
 */

const SRC = join(import.meta.dir, "..", "src");

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8");
}

/** Source with comments removed — a claim in prose is not a claim in code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Whitespace collapsed, so an assertion survives `biome check --write`. */
function flat(text: string): string {
  return code(text).replace(/\s+/g, " ");
}

const APP_LAYOUT = code(read("app", "app", "_layout.tsx"));
const APP_LAYOUT_FLAT = flat(read("app", "app", "_layout.tsx"));
const ROOT_LAYOUT = code(read("app", "_layout.tsx"));
/**
 * **The provider is two files now, and these guards read both.**
 *
 * `VoiceProvider` was over the size threshold by doing two jobs: coordinating
 * what the agent is told and what its answers do to the URL, *and* owning the
 * credential, the socket and the state they produce. The second is
 * `use-voice-session.ts`.
 *
 * Every guard below is about the pair — the session survives navigation, every
 * tool call is answered, the context is pushed and nothing is fetched — and a
 * guard reading only the coordinator would have gone *quiet* rather than red
 * the moment its subject moved one file over.
 */
const PROVIDER = [
  code(read("components", "voice", "voice-provider.tsx")),
  code(read("components", "voice", "use-voice-session.ts")),
].join("\n");
const HOOK = code(read("components", "voice", "use-voice-agent.ts"));

/** A recording port. The provider's is the one that calls `router`. */
function recorder() {
  const calls: string[] = [];
  const nav: VoiceNavigator = {
    navigate: (pathname, params) =>
      calls.push(`navigate ${pathname} ${JSON.stringify(params)}`),
    setParams: (params) => calls.push(`setParams ${JSON.stringify(params)}`),
    highlight: (subsystem) => calls.push(`highlight ${String(subsystem)}`),
    refuse: (reason) => calls.push(`refuse ${reason}`),
  };
  return { calls, nav };
}

describe("the provider sits above the Stack, inside ServingProvider", () => {
  it("`VoiceProvider` wraps the `Stack` — the session outlives a screen change", () => {
    // The whole feature turns on this line. A `VoiceProvider` moved inside a
    // screen, or below the `Stack`, tears down the socket on every navigation —
    // and navigation is the agent's primary action, so it would break at the
    // moment a tool call succeeded.
    expect(APP_LAYOUT_FLAT).toContain("<VoiceProvider> <Stack");
  });

  it("`VoiceDock` is a sibling of the `Stack`, not a child of a screen", () => {
    // `animation: "fade"` re-animates everything inside the stack. The dock has
    // to be the still thing while the screen behind it changes — that is what
    // makes an automatic navigation read as the assistant acting.
    expect(APP_LAYOUT_FLAT).toContain("/> <VoiceDock /> </VoiceProvider>");
  });

  it("the voice provider is inside `ServingProvider`, never outside it", () => {
    // Two sources for "is a model promoted" is the defect `ServingProvider`'s
    // own comment exists to prevent. The dock and the chrome badge must not be
    // able to disagree.
    const serving = APP_LAYOUT.indexOf("<ServingProvider>");
    const voice = APP_LAYOUT.indexOf("<VoiceProvider>");
    expect(serving).toBeGreaterThanOrEqual(0);
    expect(voice).toBeGreaterThan(serving);
  });

  it("there is no voice at the root — no dock on the landing page or /pitch", () => {
    // §9: "A microphone on the marketing page is a gimmick with nothing behind
    // it." The tools operate on the four modes and nothing else.
    expect(ROOT_LAYOUT).not.toContain("VoiceProvider");
    expect(ROOT_LAYOUT).not.toContain("VoiceDock");
  });

  it("the provider reads the focused screen's params, not the layout's", () => {
    // `useLocalSearchParams` in a layout above the `Stack` answers about the
    // layout. The agent must act on what the reader is looking at.
    expect(PROVIDER).toContain("useGlobalSearchParams");
    expect(PROVIDER).not.toContain("useLocalSearchParams");
  });

  it("the provider holds the microphone state — it is not asked per screen", () => {
    // Session state, held once. A copilot that re-prompts on every navigation
    // is unusable, and that is the default if this lives below the `Stack`.
    expect(PROVIDER).toContain("useState<VoiceMicState>");
  });

  it("the provider answers every tool call back to the model", () => {
    // A tool call the conversation never answers leaves the model's next turn
    // built on a gap, and the gap is where it invents the figure it was refused.
    expect(PROVIDER).toContain("respondToTool");
  });

  it("the provider pushes the context sentence, and fetches nothing of its own", () => {
    expect(PROVIDER).toContain("updateContext");
    expect(PROVIDER).toContain("contextSentence");
    // §3.4: the context is "a pure function of already-fetched state — it must
    // not issue a request of its own, or the agent's context and the screen's
    // numbers could disagree".
    expect(PROVIDER).not.toMatch(/\bfetch\s*\(/);
  });

  it("the hook layer imports no router, no socket and no React Native", () => {
    // What makes `performIntent` testable here at all. The moment this file
    // imports `expo-router`, every assertion below stops being runnable and
    // becomes a grep.
    expect(HOOK).not.toContain("expo-router");
    expect(HOOK).not.toContain("react-native");
    expect(HOOK).not.toContain("WebSocket");
  });
});

describe("an intent is performed through the port, and highlight never navigates", () => {
  it("a navigate intent pushes a route with its params", () => {
    const { calls, nav } = recorder();
    performIntent(
      {
        kind: "navigate",
        pathname: "/app/explain",
        params: { subsystem: "NE", technology: "wind" },
      },
      nav,
    );
    expect(calls).toEqual([
      'navigate /app/explain {"subsystem":"NE","technology":"wind"}',
    ]);
  });

  it("a params intent sets params and does not change route", () => {
    const { calls, nav } = recorder();
    performIntent({ kind: "params", params: { technology: "solar" } }, nav);
    expect(calls).toEqual(['setParams {"technology":"solar"}']);
  });

  /**
   * §6 step 1, and the plan calls it the step that proves the thesis:
   *
   * > It is the step where the assistant *does not navigate*, and a lesser
   * > design would have opened a chat panel with a paragraph in it.
   *
   * Asserted as an absence over the whole call record rather than as "the
   * highlight method was called", because the failure is a highlight that
   * “also” navigates — which would still call `highlight`.
   */
  it("a highlight intent lights a region and navigates nowhere", () => {
    const { calls, nav } = recorder();
    performIntent({ kind: "highlight", subsystem: "NE" }, nav);
    expect(calls).toEqual(["highlight NE"]);
    expect(calls.some((call) => call.startsWith("navigate"))).toBe(false);
    expect(calls.some((call) => call.startsWith("setParams"))).toBe(false);
  });

  it("a cleared highlight is still a highlight, not a navigation", () => {
    const { calls, nav } = recorder();
    performIntent({ kind: "highlight", subsystem: null }, nav);
    expect(calls).toEqual(["highlight null"]);
  });

  it("a refusal moves the reader nowhere", () => {
    // The highest-stakes rule in the feature: a hallucinated argument must not
    // send a reader to a screen about the wrong region. Refusing and then
    // navigating anyway would be the same defect wearing the fix.
    for (const reason of TOOL_REFUSAL_CODES) {
      const { calls, nav } = recorder();
      performIntent({ kind: "refused", reason: { code: reason } }, nav);
      expect(calls).toEqual([`refuse ${reason}`]);
    }
  });
});

describe("what the model is told happened", () => {
  it("every intent kind produces a result, including a refusal", () => {
    const intents: NavigationIntent[] = [
      { kind: "navigate", pathname: "/app", params: { subsystem: "NE" } },
      { kind: "params", params: { run: "12Z" } },
      { kind: "highlight", subsystem: "S" },
      { kind: "highlight", subsystem: null },
      { kind: "refused", reason: { code: "unknown_subsystem", value: "SUDESTE" } },
    ];
    for (const intent of intents) {
      // Non-empty *and* informative: a result of `"ok"` for every kind would
      // satisfy a length check and tell the model nothing, and the model's next
      // sentence is built on this string. Every one names what it did.
      const result = toolResult(intent);
      expect(result.length).toBeGreaterThan(8);
      expect(result).toMatch(/^(ok|refused): \S/);
    }
  });

  it("a highlight result says out loud that no screen changed", () => {
    // The model is about to speak. If the result did not distinguish a
    // highlight from a navigation, the voice would say "I opened Explain" while
    // the reader sat on the Overview.
    expect(toolResult({ kind: "highlight", subsystem: "NE" })).toContain(
      "no screen change",
    );
  });

  it("a refusal result carries the code and the value that caused it", () => {
    expect(
      toolResult({
        kind: "refused",
        reason: { code: "unknown_subsystem", field: "subsystem", value: "SUDESTE" },
      }),
    ).toBe("refused: unknown_subsystem (subsystem=SUDESTE)");
  });

  it("a scenario blob is named, not spelled, in the tool result", () => {
    // A base64 document read back to the model is 300 tokens of noise it may
    // try to interpret. The result is a sentence about what happened.
    const blob = "x".repeat(400);
    const result = toolResult({
      kind: "navigate",
      pathname: "/app/mitigate",
      params: { s: blob },
    });
    expect(result).not.toContain(blob);
    expect(result).toContain("400 chars");
  });
});

describe("the credential is replaced before it lapses", () => {
  it("re-minting is scheduled a margin ahead of expiry, never at it", () => {
    const now = Date.parse("2026-09-15T12:00:00Z");
    const expires = "2026-09-15T12:05:00Z";
    // A literal, not `5 * 60_000 - REMINT_MARGIN_MS`. Spending the constant on
    // both sides makes the assertion true for every margin including zero —
    // which is the one value it exists to forbid, because re-minting *at*
    // expiry is re-minting after it: the round trip to the gateway and on to
    // xAI takes seconds, and the socket dies during them. Found by mutating
    // the constant to 0 and watching this test still pass.
    expect(remintDelayMs(expires, now)).toBe(270_000);
    expect(REMINT_MARGIN_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("an already-stale credential re-mints now rather than in the past", () => {
    const now = Date.parse("2026-09-15T12:00:00Z");
    expect(remintDelayMs("2026-09-15T11:59:00Z", now)).toBe(0);
  });

  it("a credential whose life cannot be read is replaced immediately", () => {
    // A clock we cannot parse is one we cannot trust to outlive this turn.
    expect(remintDelayMs("", Date.now())).toBe(0);
    expect(remintDelayMs("not a date", Date.now())).toBe(0);
  });
});

describe("the three sizes, and who decides which", () => {
  it("an idle session is the IDLE pill", () => {
    expect(dockSizeFor("idle", false)).toBe("idle");
  });

  it("every live status is the ACTIVE pill", () => {
    for (const status of [
      "connecting",
      "listening",
      "thinking",
      "speaking",
      "acting",
    ] as const) {
      expect(dockSizeFor(status, false)).toBe("active");
    }
  });

  it("a reader who expanded the dock keeps it expanded through every status", () => {
    // The agent does not get to resize a panel the reader opened. A dock that
    // collapsed itself when the model started speaking would close under the
    // reader mid-sentence.
    for (const status of [
      "idle",
      "connecting",
      "listening",
      "thinking",
      "speaking",
      "acting",
      "error",
    ] as const) {
      expect(dockSizeFor(status, true)).toBe("expanded");
    }
  });

  it("an error reads as idle, not as a fourth size", () => {
    expect(dockSizeFor("error", false)).toBe("idle");
  });

  it("`isLive` covers connecting — the orb is not frozen while a socket opens", () => {
    expect(isLive("connecting")).toBe(true);
    expect(isLive("idle")).toBe(false);
    expect(isLive("error")).toBe(false);
  });
});

describe("outside the provider, voice is absent rather than pending", () => {
  it("the default context state renders nothing and does nothing", () => {
    // A component mounted with no provider above it is not waiting for an
    // answer; it is in a tree where voice was never installed. `unknown` would
    // make the landing page render a trigger.
    expect(VOICE_ABSENT.availability).toBe("absent");
    expect(VOICE_ABSENT.status).toBe("idle");
    expect(VOICE_ABSENT.transcript).toEqual([]);
    expect(() => VOICE_ABSENT.open()).not.toThrow();
    expect(() => VOICE_ABSENT.say("hello")).not.toThrow();
  });
});

describe("the transcript is bounded, because the provider is not", () => {
  /**
   * `VoiceProvider` sits above the `Stack`, so its state lives for the visit
   * rather than for a route — and `transcript` was the one piece of it that
   * only grew. Every entry is rendered: `voice-transcript.tsx` maps the array
   * into a `ScrollView`, which virtualises nothing, so a long session paid for
   * every turn it had ever had. The height was bounded and the list was not.
   */
  // The trim lives with the state it bounds, in `use-voice-session.ts`.
  const SOURCE = readFileSync(
    join(import.meta.dir, "../src/components/voice/use-voice-session.ts"),
    "utf8",
  );
  /** Comments blanked once, not per test — and named so nothing shadows it. */
  const providerCode = SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

  it("every append goes through the trim, and the streaming update does not", () => {
    // Two appends — the agent's first line of a turn, and a typed line — and
    // both must be bounded. The in-place rewrite of a streaming entry must
    // *not* be, or the window shifts under a reader mid-sentence.
    expect(providerCode).toContain("trimTranscript([...current, entry])");
    expect(providerCode.match(/trimTranscript\(/g)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );
    // The rewrite path returns the array it built, untrimmed.
    expect(providerCode).toContain("next[at] = entry;");
  });

  it("drops from the front, so what survives is the recent end", () => {
    expect(providerCode).toContain("entries.slice(entries.length - TRANSCRIPT_TURNS)");
    // Non-vacuity: a `slice(0, N)` would also compile, also bound the list, and
    // keep exactly the wrong end — the opening of a conversation nobody is
    // looking for instead of the sentence just spoken.
    expect(providerCode).not.toMatch(/slice\(0,\s*TRANSCRIPT_TURNS\)/);
  });

  it("the bound is a number a reader could reach, not a token gesture", () => {
    const declared = /const TRANSCRIPT_TURNS = (\d+);/.exec(SOURCE)?.[1];
    expect(declared).toBeDefined();
    const turns = Number(declared);
    // `MAX_HEIGHT` shows about four turns, so the window has to hold several
    // screenfuls of scrollback to be worth scrolling. Too small loses
    // something a reader might reach for; too large keeps it for nobody.
    expect({ turns, sane: turns >= 8 && turns <= 100 }).toEqual({ turns, sane: true });
  });
});
