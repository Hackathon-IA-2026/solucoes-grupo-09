/**
 * What this replay is, as a row of marks rather than a block of paragraphs.
 *
 * The Time Machine's honesty block carries two facts that change what every
 * number below means — which artifact produced the forecast, and how far the
 * settled record can be trusted — and on `/app/replay` it states them in five
 * paragraphs. On the dashboard the same two facts are **marks**, always drawn,
 * above the first figure and never collapsible:
 *
 * - the provenance badge (served, or held out by a fold artifact),
 * - "the model did not see this day", when the held-out assertion passed,
 * - the fold and the end of its training window,
 * - the vintage badge (point-in-time, or revision-optimistic).
 *
 * The paragraphs are one press away behind the ⓘ, word for word. What moved
 * behind the control is the argument; the claim stays on the screen.
 */

import type { Replay } from "@wattsteer/core/api";
import { Badge, CheckIcon, radius, space, usePalette } from "@wattsteer/ui";
import { View } from "react-native";
import { ProvenanceBadge, VintageBadge } from "@/components/app/honesty";
import { InfoHint } from "@/components/app/time-machine/info-hint";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { provenanceNote, vintageExtent, vintageNote } from "@/i18n/replay";

export function ProvenanceStrip({ replay }: { replay: Replay }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.timeMachine.strip;
  const heldOut = replay.integrity.heldOutBy;

  return (
    <View
      testID="provenance-strip"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: space.sm,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        borderLeftWidth: 3,
        borderLeftColor:
          replay.vintageFidelity === "point_in_time" ? colors.accent : colors.warning,
        backgroundColor: colors.surfaceSunken,
      }}
    >
      <ProvenanceBadge provenance={replay.integrity.provenance} />
      {replay.integrity.modelSawThisDay === false ? (
        <Badge
          label={text.modelDidNotSee}
          tone="accent"
          icon={<CheckIcon size={12} color={colors.onAccentSoft} />}
        />
      ) : null}
      {heldOut === null ? null : (
        <Badge
          label={fill(text.trainedUntil, {
            fold: heldOut.fold,
            date: f.date(heldOut.trainWindow[1]),
          })}
          tone="neutral"
        />
      )}
      <VintageBadge fidelity={replay.vintageFidelity} />
      <View style={{ flexGrow: 1 }} />
      <InfoHint
        label={copy.app.replay.honestyTitle}
        testID="provenance-details"
        points={[
          provenanceNote(replay, copy, f),
          vintageNote(replay.vintageFidelity, copy, f),
          ...vintageExtent(replay.integrity, copy),
          copy.app.replay.claimsNote,
        ]}
      />
    </View>
  );
}
