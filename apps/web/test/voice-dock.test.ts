import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core";
import {
  DOCK_NARROW_BREAKPOINT,
  DOCK_WIDTH,
  readsLevel,
  ringScale,
  screenKeyFor,
  selectionLine,
  statusLabel,
} from "../src/components/voice/use-voice-agent";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";
import { LOCALES } from "../src/i18n/locale";
import { SCREEN_PATHS, TOOL_REFUSAL_CODES } from "../src/lib/voice/execute";

/**
 * The dock — the three sizes, the orb, the action card, and the copy behind all
 * three.
 *
 * The failures this file is written against are the ones that do not throw.
 *
 *  - **A status with no sentence.** `VoiceStatus` has seven members and two of
 *    them (`thinking`, `acting`) are WattSteer's own additions — the two the
 *    reader sees at the moment they are paying most attention, and therefore
 *    the two most likely to be added to the union and forgotten in `copy`. The
 *    symptom is a pill that renders blank, in one locale, sometimes.
 *  - **A refusal with no sentence.** Thirteen codes, deliberately separated by
 *    **what the reader should hear**. A missing one renders `undefined` in the
 *    action card.
 *  - **An orb that stopped reading the microphone.** §5.1's one visual idea is
 *    that the rings are the **real** audio level. A looping animation would look
 *    almost identical in a screenshot and would be a different product.
 *  - **A dock wide enough to overflow a phone.** The symptom is not a
 *    scrollbar; `app-shell.tsx`'s header comment records what it is — a
 *    truncated word at the viewport edge.
 *
 * Every guard was checked by reintroducing the defect and watching the named
 * test fail.
 */

const SRC = join(import.meta.dir, "..", "src");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf8");
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const DOCK = code(read("components", "voice", "voice-dock.tsx"));
const ORB = code(read("components", "voice", "voice-orb.tsx"));
const TRIGGER = code(read("components", "voice", "voice-trigger.tsx"));
const TRANSCRIPT = code(read("components", "voice", "voice-transcript.tsx"));
const SHELL = code(read("components", "app", "app-shell.tsx"));
const OVERVIEW = code(read("app", "app", "index.tsx"));

const DICTIONARIES = { pt, en };

/** Every member of `VoiceStatus`, listed here so a new one fails this file. */
const STATUSES = [
  "idle",
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "acting",
  "error",
] as const;

describe("every status and every refusal has copy, in both locales", () => {
  it("the status union and the copy table have the same members", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(DICTIONARIES[locale].app.voice.status).sort()).toEqual(
        [...STATUSES].sort(),
      );
    }
  });

  it("every status renders a non-empty sentence in both locales", () => {
    for (const locale of LOCALES) {
      for (const status of STATUSES) {
        expect(statusLabel(status, DICTIONARIES[locale]).trim()).not.toBe("");
      }
    }
  });

  it("the two WattSteer statuses say something different from `listening`", () => {
    // `thinking` and `acting` exist because the interface felt dead through the
    // model's latency and glitchy through a navigation. Copy that repeated the
    // listening line would have added two statuses and changed nothing.
    for (const locale of LOCALES) {
      const voice = DICTIONARIES[locale].app.voice.status;
      expect(new Set([voice.listening, voice.thinking, voice.acting]).size).toBe(3);
    }
  });

  it("every refusal code has a sentence in both locales", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(DICTIONARIES[locale].app.voice.refusal).sort()).toEqual(
        [...TOOL_REFUSAL_CODES].sort(),
      );
    }
  });

  it("the refusals that name their alternatives actually name them", () => {
    // The refusal table is separated by what the reader should hear —
    // `unknown_subsystem` is answerable with "I know N, NE, SE and S" and
    // `unknown_run` with "there are two runs". A generic sentence in either
    // spends that separation on nothing.
    for (const subsystem of SUBSYSTEM_DISPLAY_ORDER) {
      expect(en.app.voice.refusal.unknown_subsystem).toContain(subsystem);
      expect(pt.app.voice.refusal.unknown_subsystem).toContain(subsystem);
    }
    for (const locale of LOCALES) {
      expect(DICTIONARIES[locale].app.voice.refusal.unknown_run).toContain("00Z");
      expect(DICTIONARIES[locale].app.voice.refusal.unknown_run).toContain("12Z");
    }
  });
});

describe("the orb is the real audio level", () => {
  it("listening and speaking read the level; nothing else does", () => {
    // §5.1: the microphone while the reader talks, the playback buffer while
    // the agent does. A `thinking` orb that read a level would be claiming a
    // signal it does not have.
    expect(readsLevel("listening")).toBe(true);
    expect(readsLevel("speaking")).toBe(true);
    for (const status of ["idle", "connecting", "thinking", "acting", "error"] as const) {
      expect(readsLevel(status)).toBe(false);
    }
  });

  it("a louder frame is a bigger ring — the mapping is monotonic and real", () => {
    // The guard against the orb quietly becoming a looping animation: a
    // constant would pass a screenshot and fail this.
    expect(ringScale("listening", 0.8, false)).toBeGreaterThan(
      ringScale("listening", 0.1, false),
    );
    expect(ringScale("listening", 0, false)).toBe(1);
  });

  it("the level is clamped, so a rogue frame cannot blow the pill apart", () => {
    expect(ringScale("listening", 5, false)).toBe(ringScale("listening", 1, false));
    expect(ringScale("listening", -3, false)).toBe(1);
  });

  it("reduced motion stops the level driving anything at all", () => {
    // A ring that pulses with a voice is still motion. A reader who asked for
    // none did not mean "none except the interesting one".
    for (const status of STATUSES) {
      expect(ringScale(status, 0.9, true)).toBe(1);
    }
  });

  it("the orb honours `useReducedMotion` and gates every loop on it", () => {
    expect(ORB).toContain("useReducedMotion");
    // Both looping animations are behind the flag; a loop started regardless
    // would animate under a reader who asked for stillness.
    expect(ORB).toMatch(/if \(reduced \|\|/);
  });

  it("the orb is built from Views, so no focus outline can land on an SVG", () => {
    // A CSS `outline` on an SVG element is drawn around its bounding box — on
    // this repo's map that painted a rectangle across half of Brazil. The orb
    // sits inside a focusable pill, so it must not be an SVG.
    expect(ORB).not.toContain("react-native-svg");
    expect(ORB).not.toContain("<Svg");
  });
});

describe("the three sizes", () => {
  it("the expanded panel is about 400px and is not fixed-width on a phone", () => {
    expect(DOCK_WIDTH).toBeGreaterThanOrEqual(360);
    expect(DOCK_WIDTH).toBeLessThanOrEqual(400);
    // Below the breakpoint the panel gives up its width rather than overflow.
    expect(DOCK_NARROW_BREAKPOINT).toBeGreaterThan(DOCK_WIDTH);
    expect(DOCK).toContain("DOCK_NARROW_BREAKPOINT");
  });

  it("the dock is fixed to the viewport, not absolute inside the scroller", () => {
    // The four screens are inside a `ScrollView`. An absolutely-positioned dock
    // would scroll away from the content it annotates.
    expect(DOCK).toContain('"fixed"');
  });

  it("no key means no dock — not a spinner and not a disabled control", () => {
    // §2.1 non-negotiable 4. This is the whole reason `VOICE_NOT_CONFIGURED` is
    // a separate code from `VOICE_UNAVAILABLE`.
    expect(DOCK).toMatch(/availability !== "present"[\s\S]{0,80}return null/);
  });

  it("the trigger disappears on a deployment with no key", () => {
    expect(TRIGGER).toMatch(/availability === "absent"[\s\S]{0,60}return null/);
  });

  it("the transcript is only in the expanded size", () => {
    // At the pill sizes there is nowhere to put it and the reader has not asked
    // for it.
    const expanded = DOCK.indexOf("function ExpandedPanel");
    expect(expanded).toBeGreaterThan(0);
    expect(DOCK.indexOf("<VoiceTranscript")).toBeGreaterThan(expanded);
  });

  it("the panel is opaque — no glassmorphism, blur or gradient mesh", () => {
    // §5.1 refuses all three, and the practical half of the refusal is
    // legibility: this panel sits over a fan chart.
    for (const banned of ["blurRadius", "backdropFilter", "BlurView", "LinearGradient"]) {
      expect(DOCK).not.toContain(banned);
    }
    expect(DOCK).toContain("colors.surface");
  });

  it("a denied microphone is the typed fallback, not an error", () => {
    // §8: "An explicit state in the dock with the ⌨ typed fallback, not an
    // error toast."
    expect(DOCK).toContain('agent.mic === "denied"');
    expect(DOCK).toContain("voice-dock-typed-input");
    expect(DOCK).toContain("agent.say");
  });
});

describe("keyboard and accessibility", () => {
  it("Escape collapses the expanded panel", () => {
    expect(DOCK).toContain('event.key === "Escape"');
    expect(DOCK).toContain("collapse()");
  });

  it("every dock control is a labelled button", () => {
    // Four controls: the pill's label, close, collapse, and send. A control
    // with no `accessibilityLabel` is a control a screen reader announces as
    // "button".
    const labels = DOCK.match(/accessibilityLabel=/g) ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(5);
    // Every label is copy, never a literal — the hardcoded-copy guard covers
    // the repo, and this says it locally for the file that has the most of them.
    expect(DOCK).not.toMatch(/accessibilityLabel="[A-Za-z]/);
  });

  it("every control shows focus, and the focus is on a View", () => {
    expect(DOCK).toContain("focusRing(focused");
    expect(TRIGGER).toContain("focusRing(focused");
  });

  it("the transcript announces the agent's answer to a screen reader", () => {
    // The promise of a voice interface is that the answer arrives. Keeping it
    // for someone who cannot hear it is a live region.
    expect(TRANSCRIPT).toContain('aria-live="polite"');
  });
});

describe("the action card says what happened", () => {
  it("it names the screen from the copy the tab row already uses", () => {
    // One table of screen names, not two. A second would drift the moment a
    // screen is renamed.
    expect(screenKeyFor(SCREEN_PATHS.explain)).toBe("explain");
    expect(screenKeyFor(SCREEN_PATHS.mitigate)).toBe("mitigate");
    expect(screenKeyFor(SCREEN_PATHS.replay)).toBe("replay");
    expect(screenKeyFor(SCREEN_PATHS.overview)).toBe("overview");
  });

  it("it states only the fields the intent actually carried", () => {
    // A `focus` that changed the technology and nothing else must not claim
    // three values. Claiming to have set what was not set is the small
    // dishonesty that makes a reader stop trusting the card.
    expect(selectionLine({ technology: "solar" }, en)).toBe("Solar");
    expect(selectionLine({ subsystem: "NE", technology: "wind", run: "12Z" }, en)).toBe(
      "NE · Wind · 12Z",
    );
    expect(selectionLine({ subsystem: "NE", technology: "wind", run: "12Z" }, pt)).toBe(
      "NE · Eólica · 12Z",
    );
  });

  it("it names a scenario rather than printing the blob", () => {
    const line = selectionLine({ subsystem: "NE", s: "x".repeat(300) }, en);
    expect(line).not.toContain("xxxx");
    expect(line).toContain(en.app.voice.action.scenarioChanged);
  });

  it("the copy announces an action, not a route", () => {
    // "↗ Abri Explicar para você" — first person, and the screen's own name.
    // A card that said "Navigated to /app/explain" would read as the app
    // jumping, which is the exact thing it exists to prevent.
    expect(pt.app.voice.action.navigate).toContain("{screen}");
    expect(pt.app.voice.action.navigate).toContain("você");
    expect(en.app.voice.action.navigate).toContain("{screen}");
  });
});

describe("the trigger and the map", () => {
  it("the trigger lives in the header, right of the language switch", () => {
    // §5.2. Not a nav item and not a route: a `/voice` route would put voice
    // *beside* the four modes when its whole value is sitting *across* them.
    const language = SHELL.indexOf("<LanguageSwitch");
    const trigger = SHELL.indexOf("<VoiceTrigger");
    expect(language).toBeGreaterThan(0);
    expect(trigger).toBeGreaterThan(language);
  });

  it("the trigger is not a fifth screen in the tab row", () => {
    expect(SHELL).not.toMatch(/\{ key: "voice"/);
    expect(SHELL).not.toContain('path: "/app/voice"');
  });

  it("the agent lights the map through the highlight the map already had", () => {
    // §3.1: "a one-line change to who can call `setHovered`, and no new
    // highlight mechanism at all". The pointer wins where there is one.
    expect(OVERVIEW).toContain("useVoiceHighlight");
    expect(OVERVIEW).toContain("hovered ?? spoken");
  });
});
