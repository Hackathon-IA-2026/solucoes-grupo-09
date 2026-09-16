/**
 * Which scene is on screen, decided by the narration rather than by a timer.
 *
 * **The master clock is the audio, and it has to be.** A briefing is a sentence
 * and a picture making the same claim; if they drift apart the picture is
 * illustrating the wrong sentence, which is worse than not animating at all. So
 * nothing here runs an interval of its own — the caller reports how much
 * narration has actually played and this module answers what should be visible.
 *
 * `compose.ts` lays scenes out at a nominal length because it cannot know how
 * long the speech model will talk for. This module reconciles the two:
 *
 *  - **Narration longer than the plan** — the last scene holds. A briefing that
 *    ran out of pictures and went blank while still talking would read as a
 *    crash.
 *  - **Narration shorter than the plan** — scenes compress proportionally, down
 *    to `MIN_SCENE_MS`. Below that a scene is a flash rather than a picture, so
 *    the sequence accepts overrunning the audio instead.
 *  - **No audio at all** — autoplay refused, or the reader has sound off. The
 *    caller falls back to a wall clock and the narration is shown as text; this
 *    module does not care which clock it is handed, which is what makes that
 *    fallback a two-line change rather than a second code path.
 *
 * `VISUAL_PLAN.md` §4.
 */

import { type BriefingPlan, MIN_SCENE_MS, type TimedScene } from "./types";

/**
 * Stretch or squeeze a plan onto the narration that actually played.
 *
 * `narrationMs` of zero or less means "not known yet" and the plan is returned
 * as composed — the opening scene is correct either way, and guessing a scale
 * from no information would only make the first scene wrong.
 */
export function fitToNarration(
  scenes: readonly TimedScene[],
  narrationMs: number,
): readonly TimedScene[] {
  if (scenes.length === 0 || narrationMs <= 0) {
    return scenes;
  }
  const planned = scenes.reduce((total, timed) => total + timed.duration, 0);
  if (planned <= 0) {
    return scenes;
  }
  // Only ever compressed. Stretching scenes to fill a long narration would slow
  // the whole briefing down to match its wordiest sentence; the last scene
  // holding is the better answer and `activeSceneIndex` already gives it.
  const scale = Math.min(1, narrationMs / planned);
  if (scale === 1) {
    return scenes;
  }

  let start = 0;
  const fitted: TimedScene[] = [];
  for (const timed of scenes) {
    const duration = Math.max(MIN_SCENE_MS, Math.round(timed.duration * scale));
    fitted.push({ scene: timed.scene, start, duration });
    start += duration;
  }
  return fitted;
}

/**
 * The scene visible at `elapsedMs`, as an index into `scenes`.
 *
 * Past the end it is the last scene, not `-1`: see the hold rule above. Before
 * the start it is the first, because a briefing opens on its title the instant
 * it is asked for rather than after the first syllable.
 */
export function activeSceneIndex(
  scenes: readonly TimedScene[],
  elapsedMs: number,
): number {
  if (scenes.length === 0) {
    return -1;
  }
  if (elapsedMs <= 0) {
    return 0;
  }
  for (let index = scenes.length - 1; index >= 0; index -= 1) {
    const timed = scenes[index];
    if (timed !== undefined && elapsedMs >= timed.start) {
      return index;
    }
  }
  return 0;
}

/** Whether the sequence has run past its last scene's end. */
export function isComplete(scenes: readonly TimedScene[], elapsedMs: number): boolean {
  const last = scenes.at(-1);
  return last !== undefined && elapsedMs >= last.start + last.duration;
}

/**
 * How far through the *current* scene we are, 0..1.
 *
 * The renderer uses it for enter and exit transitions. It is clamped rather
 * than allowed to run past 1 while the last scene holds, so a held scene sits
 * at its resting state instead of animating forever.
 */
export function sceneProgress(scenes: readonly TimedScene[], elapsedMs: number): number {
  const index = activeSceneIndex(scenes, elapsedMs);
  const timed = index < 0 ? undefined : scenes[index];
  if (timed === undefined || timed.duration <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, (elapsedMs - timed.start) / timed.duration));
}

/**
 * A briefing in flight: the plan, fitted, plus where the narration has reached.
 *
 * Deliberately a value rather than a class. The director holds one of these and
 * replaces it; nothing here owns a timer, a subscription or an `AudioContext`,
 * so every rule above is testable with three numbers and no browser.
 */
export interface BriefingCursor {
  readonly scenes: readonly TimedScene[];
  readonly index: number;
  readonly progress: number;
  readonly complete: boolean;
}

export function cursorFor(
  plan: BriefingPlan,
  elapsedMs: number,
  narrationMs: number,
): BriefingCursor {
  const scenes = fitToNarration(plan.scenes, narrationMs);
  return {
    scenes,
    index: activeSceneIndex(scenes, elapsedMs),
    progress: sceneProgress(scenes, elapsedMs),
    complete: isComplete(scenes, elapsedMs),
  };
}
