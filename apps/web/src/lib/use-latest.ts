/**
 * The current value of something, readable from a callback that outlived the
 * render it was installed in.
 *
 * This is the "latest value" idiom, and the three call sites that use it all
 * want the same thing: an input the callback should read *now*, as opposed to a
 * dependency that should re-run it. `use-optimization.ts` wants the scenario
 * without re-solving when React rebuilds an identical object; `use-replay.ts`
 * wants the same; `voice-provider.tsx` wants a socket handler installed once to
 * execute a tool call against the URL the reader is on three navigations later.
 * Closing over the value instead would be the stale-closure bug in each case,
 * and in the voice one it would be invisible — every intent would still be a
 * valid URL, just the wrong one.
 *
 * **The assignment is in an effect, not in the render body**, and that is the
 * only thing this file adds over the two lines it replaces. Writing a ref
 * during render is a side effect in render, which React 19 documents as
 * unsupported and which this app cannot treat as merely unfashionable: the
 * static export enables `reactCompiler` (`app.json`), and the compiler is
 * entitled to memoise, re-order or discard a render whose result it can prove
 * it already has. A render that is thrown away must leave nothing behind, and a
 * ref written during it does.
 *
 * **Call it above the effect or callback that reads it.** Effects run in the
 * order their hooks were called, so a `useLatest` above the consumer has always
 * committed this render's value before the consumer runs; one below it has not.
 * Every caller here is written that way. Nothing reads the ref during render —
 * that would be the other half of the same rule, and it would also be wrong,
 * because the value is right there in scope.
 */

import { type RefObject, useEffect, useRef } from "react";

export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
