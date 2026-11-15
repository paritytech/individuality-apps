// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Debug-panel daily-dollar simulation — the scratch card driven by the
 *  debug store instead of the chain. No claim is ever submitted
 *  and nothing is written to host storage: revealing the card settles the
 *  simulated prize in the panel's own state. */
import { useRef } from "react";

import type { DebugPrizeState } from "@features/debug/debug-prize-state.ts";
import { DailyPrizeScreen } from "@features/prize/components/index.ts";
import type { ScratchOutcome } from "@features/prize/components/ScratchCard.tsx";
import { formatDateLabel } from "@features/prize/domain/live-prize-surface.ts";

/** A simulation the panel has actually picked an outcome for. */
export type ActiveDebugPrize = DebugPrizeState & { outcome: ScratchOutcome };

export function isActiveDebugPrize(
  prize: DebugPrizeState,
): prize is ActiveDebugPrize {
  return prize.outcome != null;
}

export interface DebugDailyScreenProps {
  prize: ActiveDebugPrize;
  /** Consumes the simulated ticket; idempotent, so the reveal may call it. */
  onSettle: () => void;
  onBack: () => void;
}

export function DebugDailyScreen({
  prize,
  onSettle,
  onBack,
}: DebugDailyScreenProps) {
  // Read once per mount: settling flips `revealed`, and feeding it back into
  // a mid-animation scratch would tear the reveal down.
  const enteredRevealed = useRef(prize.revealed);

  return (
    <DailyPrizeScreen
      ticket={{
        outcome: prize.outcome,
        amountLabel: "$1",
        dateLabel: formatDateLabel(new Date()),
        oddsLabel: "",
      }}
      onDone={onBack}
      onRevealed={onSettle}
      revealed={enteredRevealed.current}
    />
  );
}
