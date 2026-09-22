/**
 * The promoted lane's model card, read **once** per lane.
 *
 * Two things on the Overview are measured on the same card — the band's
 * coverage and the ladder's delta over the mandatory baseline — and each used
 * to be, or would have been, its own request for the same document. `/v1/meta`
 * is read through one provider for exactly this reason, stated there: two
 * readers of one fact must never disagree, and a card fetched twice can be
 * answered twice by a gateway mid-promotion.
 *
 * This is the cheaper half of that rule. The card is immutable for a given
 * lane — the lane name carries the family, the gate and the threshold, and a
 * new artifact is a new `artifact_id` inside a card that is refetched on the
 * next load — so the read is memoised by lane for the life of the page. A
 * screen that mounts three readers issues one request.
 *
 * ## The lane is found, never composed
 *
 * `dessem_free_v1__gate_early__thr5` is a family, a gate and a threshold in one
 * identifier, and only `/v1/meta` knows which are deployed. Building the string
 * here would be a second source of it that drifts silently.
 */

import type { GateProfile, ModelCard } from "@wattsteer/core/api";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { servingLaneFor } from "@/lib/lanes";
import { settleWith } from "@/lib/settle";
import { useServing } from "../use-serving";

export type ModelCardState =
  | { readonly status: "reading" }
  /** No promoted lane for this gate, or the card would not answer. */
  | { readonly status: "absent" }
  | { readonly status: "read"; readonly card: ModelCard };

/**
 * One in-flight or settled read per lane.
 *
 * A promise rather than a value, so two hooks mounting in the same commit share
 * the request instead of racing to start two. `null` is cached too — a lane
 * whose card refused is a lane whose card will refuse again on this page, and
 * retrying it per mount would be a request per panel per render.
 */
const cards = new Map<string, Promise<ModelCard | null>>();

function read(lane: string): Promise<ModelCard | null> {
  const pending = cards.get(lane);
  if (pending !== undefined) {
    return pending;
  }
  // Deliberately un-aborted: the promise is shared, so one unmounting reader
  // must not cancel the read another is waiting on. Each caller drops its own
  // result instead, which is what the `aborted` check below does.
  const started = api
    .modelCard({ lane })
    .then((card) => card)
    .catch(() => null);
  cards.set(lane, started);
  return started;
}

/** The lane serving this gate, or `undefined` while that is not known. */
export function usePromotedLane(
  /*
    `null` is admitted and behaves exactly as a profile with no serving lane
    does — `absent`, not a guess. The Time Machine reads its profile off the
    lane `/v1/meta` says is serving, and that is unknown for one render.
  */
  gateProfile: GateProfile | null,
): string | undefined {
  const serving = useServing();
  return serving.status === "known" && gateProfile !== null
    ? servingLaneFor(serving.lanes, gateProfile)?.name
    : undefined;
}

export function useModelCard(gateProfile: GateProfile | null): ModelCardState {
  const serving = useServing();
  const lane = usePromotedLane(gateProfile);
  const [state, setState] = useState<ModelCardState>({ status: "reading" });

  useEffect(() => {
    if (serving.status !== "known") {
      return;
    }
    if (lane === undefined) {
      setState({ status: "absent" });
      return;
    }
    const controller = new AbortController();
    const settle = settleWith(controller.signal, setState);
    read(lane).then((card) => {
      // A card that will not answer is an absent measurement, not a broken
      // screen: nothing on these screens depends on it.
      settle(card === null ? { status: "absent" } : { status: "read", card });
    });
    return () => controller.abort();
  }, [lane, serving.status]);

  return state;
}
