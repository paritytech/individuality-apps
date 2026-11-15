// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Mirrors the panel's card scenario onto the host's Pocket card.
 *
 * The scenario already replaces the card the app reads (`useDebugCardOverride`);
 * the Pocket card is drawn by the worker from its own reading, so without this
 * the two would disagree while a scenario is picked. The state the app derives
 * for the scenario is written to the product's storage in the face's terms,
 * and the worker draws it while its card is on screen. Going back to reading
 * from chain clears it.
 */
import { useEffect } from "react";
import { deriveHumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import { toPocketFaceState } from "@humanity/shared/pocket/pocket-face-state.ts";
import { writePocketFaceOverride } from "@humanity/shared/pocket/pocket-face-override.ts";
import { scenarioSnapshot } from "./debug-scenarios.ts";
import { useDebugStore } from "./debug-store.ts";

export function usePocketFaceMirror(): void {
  const scenario = useDebugStore((state) => state.scenario);
  const candidateProgress = useDebugStore((state) => state.candidateProgress);
  const memberWeeks = useDebugStore((state) => state.memberWeeks);

  useEffect(() => {
    void writePocketFaceOverride(
      scenario == null ? null : toPocketFaceState(deriveHumanityCardState(scenarioSnapshot(scenario, candidateProgress, memberWeeks))),
    );
  }, [scenario, candidateProgress, memberWeeks]);
}
