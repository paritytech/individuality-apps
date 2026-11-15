// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Keeps dotNS in step with People: whenever the live card shows a full
 * username the dotNS gateway does not hold for the card's account, register
 * it (`claim-dotns-name.ts`), and keep trying every 30 s while the failure
 * is one that can clear on its own (the host asleep, Asset Hub behind on a
 * ring root, a timeout).
 *
 * One hook serves both moments: the claim the person just made in this app
 * (the card refetch after `Resources.register_person` shows the name, the
 * gateway does not), and every name claimed before the app registered
 * names in dotNS at all (#1433). The gateway read is its own query, off the
 * card's critical path: a lite person never pays for an Asset Hub
 * connection, and a member only after the card is on screen.
 */
import { useEffect, useReducer } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { claimDotnsName, type DotnsNameClaimOutcome } from "@features/card/chain/claim-dotns-name.ts";
import { dotnsClaimGate, type DotnsClaimGate } from "@features/card/domain/dotns-name-claim.ts";
import { readDotnsNameClaim } from "@features/card/storage/dotns-name-claim-store.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import type { RingPosition } from "@humanity/shared/chain/ring-membership.ts";
import { readDotnsGatewayNames } from "@humanity/shared/chain/dotns-gateway/read-names.ts";
import { parseHumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("card", "dotns-name");

export const DOTNS_NAME_CLAIM_MUTATION_KEY = ["card", "dotns-name-claim"] as const;
export const dotnsGatewayNamesKey = (owner: string) => ["chain", "dotns-gateway-names", owner] as const;

let lastGateLogged = "";
let lastGate: DotnsClaimGate | null = null;
/** Owners with an attempt started but not yet reflected by `useIsMutating`. */
const inFlight = new Set<string>();

/** The last gate the automatic path evaluated, for the debug panel. */
export function lastDotnsClaimGate(): DotnsClaimGate | null {
  return lastGate;
}

/**
 * The full username the live card shows and the account it belongs to, or
 * nulls: the inputs the gate needs, nothing of the card's other state.
 */
export function dotnsClaimSubject(
  card: HumanityCardResult | undefined,
  live: boolean,
): { owner: string | null; fullUsername: string | null; membership: RingPosition | null } {
  if (!live || card?.kind !== "card") return { owner: null, fullUsername: null, membership: null };
  const identity = parseHumanityUserId(card.primaryUsername);
  return {
    owner: card.accountAddress,
    fullUsername: identity?.isUpgraded === true ? identity.username : null,
    membership: card.membershipStanding?.position ?? null,
  };
}

export function useDotnsNameClaim(card: HumanityCardResult | undefined, live: boolean): void {
  const queryClient = useQueryClient();
  const { owner, fullUsername, membership } = dotnsClaimSubject(card, live);
  const gateway = useQuery({
    queryKey: dotnsGatewayNamesKey(owner ?? ""),
    queryFn: () => readDotnsGatewayNames(owner ?? ""),
    enabled: owner != null && fullUsername != null,
    staleTime: 30_000,
    retry: 2,
  });
  const busy = useIsMutating({ mutationKey: DOTNS_NAME_CLAIM_MUTATION_KEY }) > 0;
  const { mutate } = useMutation<DotnsNameClaimOutcome, unknown, { owner: string; label: string }>({
    mutationKey: DOTNS_NAME_CLAIM_MUTATION_KEY,
    mutationFn: ({ owner: target, label }) => claimDotnsName({ owner: target, label, source: "auto" }),
    onSettled: (_outcome, _error, { owner: target }) => {
      inFlight.delete(target);
      void queryClient.invalidateQueries({ queryKey: dotnsGatewayNamesKey(target) });
      wake();
    },
  });
  const [tick, wake] = useReducer((n: number) => n + 1, 0);

  const record = owner == null ? null : readDotnsNameClaim(owner);
  const gate = dotnsClaimGate({
    owner,
    fullUsername,
    gateway: gateway.data,
    record,
    membership,
    busy: busy || (owner != null && inFlight.has(owner)),
    now: Date.now(),
  });
  const wakeAt = gate.kind === "holding" ? gate.until : 0;
  const label = gate.kind === "firing" ? gate.label : null;

  useEffect(() => {
    lastGate = gate;
    const signature = `${gate.kind}|${gate.detail}`;
    if (signature !== lastGateLogged) {
      lastGateLogged = signature;
      logger.info("gate: {kind}; {detail}", { kind: gate.kind, detail: gate.detail });
    }
    if (owner == null || label == null || inFlight.has(owner)) return;
    inFlight.add(owner);
    mutate({ owner, label });
  }, [gate, label, owner, mutate]);

  useEffect(() => {
    if (wakeAt <= 0) return;
    const timer = setTimeout(() => {
      wake();
      if (owner != null) void queryClient.invalidateQueries({ queryKey: dotnsGatewayNamesKey(owner) });
    }, Math.max(wakeAt - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [wakeAt, tick, owner, queryClient]);
}
