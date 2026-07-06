import type { AppInfo, Target } from "@noviq/core";
import { useEffect, useRef, useState } from "react";
import { client } from "@/lib/config";

export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; target: Target }
  | { status: "ready"; target: Target; appInfo: AppInfo }
  | { status: "none"; target: Target };

/** Wait this long after the last keystroke before hitting the network. */
const DEBOUNCE_MS = 600;

/**
 * Debounced app-metadata preview: the moment a pasted link resolves, fetch
 * the app's name/icon/rating so the user sees *their* app before committing
 * to a scrape (recognition over recall; Doherty: immediate feedback).
 * Best-effort — failures degrade to "none" and never block the flow.
 */
export function useAppPreview(target: Target | null): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const keyRef = useRef<string>("");

  useEffect(() => {
    if (!target) {
      keyRef.current = "";
      setState({ status: "idle" });
      return;
    }
    const key = `${target.store}:${target.appId}:${target.country ?? ""}`;
    if (key === keyRef.current) return; // same app — keep whatever we have
    keyRef.current = key;

    const abort = new AbortController();
    setState({ status: "loading", target });

    const timer = setTimeout(async () => {
      try {
        const result = await client.appInfo(
          { appId: target.appId, store: target.store, country: target.country },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setState(
          result.appInfo
            ? { status: "ready", target, appInfo: result.appInfo }
            : { status: "none", target },
        );
      } catch {
        if (!abort.signal.aborted) setState({ status: "none", target });
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abort.abort();
      keyRef.current = "";
    };
  }, [target]);

  return state;
}
