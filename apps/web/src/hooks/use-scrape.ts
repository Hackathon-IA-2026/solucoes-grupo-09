import {
  initialScrapeState,
  isBusy,
  type ScrapeRequest,
  type ScrapeState,
  transition,
} from "@noviq/core";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { client } from "@/lib/config";
import { runScrape } from "@/lib/scrape-controller";

export interface UseScrape {
  state: ScrapeState;
  busy: boolean;
  submit: (request: ScrapeRequest) => void;
  cancel: () => void;
  reset: () => void;
}

/**
 * React binding for the scrape machine: `useReducer` over the pure
 * `transition`, with the network controller as the only side effect. One
 * AbortController per submission guarantees stale pollers can never write
 * into a newer flow (the machine also ignores them by job id — belt and
 * braces).
 */
export function useScrape(): UseScrape {
  const [state, dispatch] = useReducer(transition, initialScrapeState);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const submit = useCallback((request: ScrapeRequest) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "SUBMIT", request });
    void runScrape(client, request, dispatch, { signal: controller.signal });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: "CANCEL" });
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: "RESET" });
  }, []);

  return { state, busy: isBusy(state), submit, cancel, reset };
}
