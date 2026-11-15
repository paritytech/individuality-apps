// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { HumanityCardSnapshot } from "@humanity/shared/card/humanity-card-state.ts";

export type SuspensionRecovery = "unknown" | "play" | "ready";

/** Score.register(None) resumes only an account suspended by Score. A ring
 * suspension on its own does not establish a cause or a recovery path. */
export function suspensionRecovery(snapshot: HumanityCardSnapshot | undefined): SuspensionRecovery {
  const participant = snapshot?.participant;
  if (participant?.recognition !== "Suspended" || snapshot == null) return "unknown";
  return participant.reachedPersonhood || participant.score >= snapshot.personhoodThreshold
    ? "ready"
    : "play";
}
