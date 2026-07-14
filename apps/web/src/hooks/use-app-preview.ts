import type { AppInfo, Target } from "@zalytix/core";
import { useEffect, useState } from "react";
import { client } from "@/lib/config";

export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; target: Target }
  | { status: "ready"; target: Target; appInfo: AppInfo }
  | { status: "none"; target: Target };

/** Wait this long after the last keystroke before hitting the network. */
const DEBOUNCE_MS = 600;

const IDLE: PreviewState = { status: "idle" };

/**
 * Debounced app-metadata preview: the moment a pasted link resolves, fetch
 * the app's name/icon/rating so the user sees *their* app before committing
 * to a scrape (recognition over recall; Doherty: immediate feedback).
 * Best-effort — failures degrade to "none" and never block the flow.
 *
 * State is keyed by the resolved target: the effect only *fetches* (async
 * setState), and idle/loading are derived at render, so a target change never
 * needs a synchronous state reset.
 */
export function useAppPreview(target: Target | null): PreviewState {
  const store = target?.store;
  const appId = target?.appId;
  const country = target?.country;
  const key = store && appId ? `${store}:${appId}:${country ?? ""}` : null;

  const [fetched, setFetched] = useState<{
    key: string;
    state: PreviewState;
  } | null>(null);

  // Adjust-during-render: once the target clears, forget the previous result
  // so re-entering the same link fetches fresh (a transient failure must not
  // pin the preview to a stale "none").
  if (!key && fetched !== null) {
    setFetched(null);
  }

  useEffect(() => {
    if (!(key && store && appId)) {
      return;
    }
    const effectTarget: Target = { store, appId, country };
    const abort = new AbortController();
    const timer = setTimeout(() => {
      client
        .appInfo({ appId, store, country }, abort.signal)
        .then((result) => {
          if (abort.signal.aborted) {
            return;
          }
          setFetched({
            key,
            state: result.appInfo
              ? { status: "ready", target: effectTarget, appInfo: result.appInfo }
              : { status: "none", target: effectTarget },
          });
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            setFetched({ key, state: { status: "none", target: effectTarget } });
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [key, store, appId, country]);

  if (!(target && key)) {
    return IDLE;
  }
  if (fetched?.key === key) {
    return fetched.state;
  }
  return { status: "loading", target };
}
