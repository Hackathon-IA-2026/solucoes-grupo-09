/**
 * Filing a verdict about one answer, and saying what happened to it.
 *
 * ## Why a hook and not a call inside the component
 *
 * The three screens that collect this are three different answers — a day's
 * forecast, a replay, a cited ONS passage — and the only thing they share is
 * what happens *after* the press: it is sent, it is filed, or it is refused and
 * the reader has to be told. That is state, and a `.tsx` exports components and
 * nothing else (ADR-0002).
 *
 * ## Why a refusal is stated rather than swallowed
 *
 * A thumbs-down that quietly vanished is the one failure this surface cannot
 * absorb: the reader believes they have told us, and nobody has. So `failed` is
 * a state the control renders in words, exactly as every other absence on these
 * screens is rendered — `honesty.md`'s rule, applied to a write.
 *
 * The success sentence is equally deliberate: **filed, not acted on**. Nothing
 * a reader marks here changes the screen, and a control implying otherwise
 * would be promising a correction that is not coming.
 */

import type {
  FeedbackSubject,
  FeedbackSurface,
  FeedbackVerdict,
} from "@wattsteer/core/api";
import { useState } from "react";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";

export type FeedbackState =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "filed"; readonly verdict: FeedbackVerdict }
  | { readonly status: "failed"; readonly tooLong: boolean };

export interface FeedbackFiler {
  readonly state: FeedbackState;
  /** File a verdict. `reason` is the reader's words, and only theirs. */
  readonly file: (verdict: FeedbackVerdict, reason?: string) => Promise<void>;
}

/** The gateway's limit, restated so the control can refuse before the round trip. */
export const MAX_REASON_CHARS = 400;

export function useFeedback(
  surface: FeedbackSurface,
  subject: FeedbackSubject,
): FeedbackFiler {
  const [state, setState] = useState<FeedbackState>({ status: "idle" });
  const { locale } = useI18n();

  const file = async (verdict: FeedbackVerdict, reason?: string) => {
    const written = reason?.trim();
    if (written !== undefined && written.length > MAX_REASON_CHARS) {
      // Refused here rather than at the gateway, because the reader is still
      // looking at the box they typed it into.
      setState({ status: "failed", tooLong: true });
      return;
    }
    setState({ status: "sending" });
    try {
      await api.fileFeedback({
        surface,
        verdict,
        subject,
        ...(written === undefined || written === "" ? {} : { reason: written }),
        locale,
      });
      setState({ status: "filed", verdict });
    } catch {
      /*
        Every refusal reads the same to the reader — it was not recorded — and
        the code behind it is an operator's fact, not theirs. `error-copy.test.ts`
        forbids rendering the envelope's own message, so there is nothing here
        to distinguish that a sentence could honestly use.
      */
      setState({ status: "failed", tooLong: false });
    }
  };

  return { state, file };
}
