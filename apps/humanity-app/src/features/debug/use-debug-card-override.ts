// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo } from "react";

import {
  deriveHumanityCardState,
} from "@humanity/shared/card/humanity-card-state.ts";
import type { ResolvedHumanityCard } from "@humanity/shared/card/humanity-card-data.ts";
import type { HumanityCardQuery } from "@features/card/hooks/use-humanity-card.ts";
import { DEBUG_PANEL } from "@humanity/shared/config/debug-panel.ts";

import { scenarioSnapshot } from "./debug-scenarios.ts";
import { useDebugStore } from "./debug-store.ts";
import { setDebugContext } from "@humanity/shared/telemetry/app-context.ts";

const DEBUG_ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const DEBUG_PLAYER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

export function useDebugCardOverride(query: HumanityCardQuery): HumanityCardQuery {
  const scenario = useDebugStore((state) => state.scenario);
  const candidateProgress = useDebugStore((state) => state.candidateProgress);
  const memberWeeks = useDebugStore((state) => state.memberWeeks);
  useEffect(() => setDebugContext(DEBUG_PANEL ? scenario : null), [scenario]);

  return useMemo(() => {
    if (!DEBUG_PANEL || scenario == null) return query;

    const snapshot = scenarioSnapshot(scenario, candidateProgress, memberWeeks);
    const liveCard = query.data?.kind === "card" ? query.data : null;
    const card: ResolvedHumanityCard = {
      kind: "card",
      // A numbered username for every state before Membership: a bare name
      // is what upgrading grants, and `membership-ready` is precisely the
      // state that has not been granted it yet.
      primaryUsername:
        liveCard?.primaryUsername ??
        (scenario === "devicehood" || scenario === "membership-ready"
          ? "debug.42"
          : "debug.polkadot"),
      accountAddress: liveCard?.accountAddress ?? DEBUG_ACCOUNT,
      ownerAccount: liveCard?.ownerAccount ?? DEBUG_ACCOUNT,
      participant: snapshot.participant,
      // Scenarios drive the state machine, not the Devicehood record; the
      // live one survives so its panel rows keep showing the real chain. The
      // ring standings are the same deal — the scenario's `membershipRing`
      // and `devicehoodRing` steer the state, while these rows keep
      // reporting the real person.
      devicehood: liveCard?.devicehood ?? null,
      membershipStanding: liveCard?.membershipStanding ?? null,
      devicehoodRing: liveCard?.devicehoodRing ?? null,
      deviceKeyCheck: liveCard?.deviceKeyCheck ?? null,
      state: deriveHumanityCardState(snapshot),
      playerIdentities: liveCard?.playerIdentities ?? {
        accountAddress: DEBUG_PLAYER,
      },
      snapshot,
    };
    return { data: card, error: null, isPending: false };
  }, [scenario, candidateProgress, memberWeeks, query.data, query.error, query.isPending]);
}
