/**
 * The clock, which is the part of a briefing a reader notices when it is wrong.
 *
 * Every rule here exists because the two halves of a briefing — the sentence
 * and the picture — are making the same claim, and narration length is decided
 * by the speech model rather than by the composer. So the plan is nominal and
 * this module reconciles it with what actually played.
 */

import { describe, expect, it } from "bun:test";
import {
  activeSceneIndex,
  cursorFor,
  fitToNarration,
  isComplete,
  sceneProgress,
} from "@/lib/voice/briefing/clock";
import {
  type BriefingPlan,
  DEFAULT_SCENE_MS,
  MIN_SCENE_MS,
  type Scene,
  type TimedScene,
} from "@/lib/voice/briefing/types";

/** Four scenes at the composer's nominal length — 14 000 ms in total. */
function plannedScenes(count = 4): TimedScene[] {
  const scene: Scene = { type: "sources" };
  return Array.from({ length: count }, (_unused, index) => ({
    scene,
    start: index * DEFAULT_SCENE_MS,
    duration: DEFAULT_SCENE_MS,
  }));
}

describe("which scene is on screen", () => {
  const scenes = plannedScenes();

  it("opens on the title before a syllable has played", () => {
    // A briefing appears the instant it is asked for. Waiting for audio would
    // leave the reader looking at a dimmed screen with nothing on it.
    expect(activeSceneIndex(scenes, 0)).toBe(0);
    expect(activeSceneIndex(scenes, -500)).toBe(0);
  });

  it("changes exactly on the boundary, not a frame either side", () => {
    expect(activeSceneIndex(scenes, DEFAULT_SCENE_MS - 1)).toBe(0);
    expect(activeSceneIndex(scenes, DEFAULT_SCENE_MS)).toBe(1);
    expect(activeSceneIndex(scenes, DEFAULT_SCENE_MS * 2)).toBe(2);
  });

  it("holds the last scene while the narration runs long", () => {
    // The failure this prevents: a briefing that runs out of pictures and goes
    // blank while it is still talking, which reads as a crash.
    expect(activeSceneIndex(scenes, DEFAULT_SCENE_MS * 40)).toBe(scenes.length - 1);
  });

  it("has no scene to show for an empty plan", () => {
    expect(activeSceneIndex([], 1000)).toBe(-1);
  });
});

describe("fitting the plan to the narration", () => {
  const scenes = plannedScenes();
  const planned = DEFAULT_SCENE_MS * scenes.length;

  it("leaves the plan alone until the narration length is known", () => {
    expect(fitToNarration(scenes, 0)).toEqual(scenes);
    expect(fitToNarration(scenes, -1)).toEqual(scenes);
  });

  it("compresses proportionally when the narration comes in short", () => {
    const fitted = fitToNarration(scenes, planned / 2);

    expect(fitted).toHaveLength(scenes.length);
    for (const timed of fitted) {
      expect(timed.duration).toBe(DEFAULT_SCENE_MS / 2);
    }
    // Still laid end to end, which is what the renderer assumes.
    expect(fitted[0]?.start).toBe(0);
    expect(fitted[1]?.start).toBe(DEFAULT_SCENE_MS / 2);
  });

  it("refuses to compress a scene into a flash", () => {
    // Asked to fit four scenes into 400 ms, the floor wins and the sequence
    // overruns the audio instead. A 100 ms scene is not a picture.
    const fitted = fitToNarration(scenes, 400);

    for (const timed of fitted) {
      expect(timed.duration).toBe(MIN_SCENE_MS);
    }
  });

  it("does not stretch to fill a long narration", () => {
    // Stretching would slow the whole briefing to match its wordiest sentence.
    // The last scene holding is the better answer, and `activeSceneIndex`
    // already gives it.
    expect(fitToNarration(scenes, planned * 3)).toEqual(scenes);
  });
});

describe("progress through the current scene", () => {
  const scenes = plannedScenes();

  it("runs 0 to 1 across a scene", () => {
    expect(sceneProgress(scenes, 0)).toBe(0);
    expect(sceneProgress(scenes, DEFAULT_SCENE_MS / 2)).toBeCloseTo(0.5, 5);
  });

  it("rests at 1 while the last scene holds rather than animating forever", () => {
    expect(sceneProgress(scenes, DEFAULT_SCENE_MS * 100)).toBe(1);
  });
});

describe("completion", () => {
  const scenes = plannedScenes();

  it("is not complete during the last scene", () => {
    expect(isComplete(scenes, DEFAULT_SCENE_MS * 3 + 1)).toBe(false);
  });

  it("is complete once the last scene's own time is up", () => {
    expect(isComplete(scenes, DEFAULT_SCENE_MS * 4)).toBe(true);
  });

  it("is never complete with nothing to play", () => {
    expect(isComplete([], 10_000)).toBe(false);
  });
});

describe("the cursor the director holds", () => {
  const plan: BriefingPlan = {
    locale: "pt",
    kind: "why",
    scenes: plannedScenes(),
    sources: [],
  };

  it("fits and locates in one step", () => {
    const planned = DEFAULT_SCENE_MS * plan.scenes.length;
    const cursor = cursorFor(plan, DEFAULT_SCENE_MS, planned / 2);

    // Halved scenes, so the nominal first boundary is now the third scene.
    expect(cursor.scenes[0]?.duration).toBe(DEFAULT_SCENE_MS / 2);
    expect(cursor.index).toBe(2);
    expect(cursor.complete).toBe(false);
  });

  it("reports completion at the end of the fitted sequence", () => {
    const cursor = cursorFor(plan, 10 * DEFAULT_SCENE_MS, 0);

    expect(cursor.complete).toBe(true);
    expect(cursor.index).toBe(plan.scenes.length - 1);
  });
});
