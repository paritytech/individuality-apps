// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useMemo } from "react";
import type { GameRegistration } from "@individuality/shared-records";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Enum } from "polkadot-api";

import { useGameRegistration } from "@features/card/hooks/use-game-registration.ts";
import {
  toHumanityCardParticipant,
  type RawParticipant,
  type ResolvedHumanityCard,
} from "@humanity/shared/card/humanity-card-data.ts";
import { deriveHumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import { CHAIN_READ_TIMEOUT_MS } from "@humanity/shared/chain/bounded-read.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";

/** One People Chain block, while nothing says a sign-up is on its way. */
const BEST_POLL_IDLE_MS = 12_000;
/** While Jollity has a sign-up on its way, or landed one the finalized read
 *  has yet to see, about every half block. */
const BEST_POLL_SIGNUP_MS = 3_000;

/**
 * What a sign-up writes before its first game: no score, no streak, not yet
 * recognised. Shown only from the broadcast until best holds the real record.
 */
const FRESH_PARTICIPANT: RawParticipant = {
  score: 0,
  streak: { type: "Attended", value: 0 },
  attendance_history: 0,
  credit: 0n,
  cashed_out: false,
  reached_personhood: false,
  has_ever_reached_personhood: false,
  recognition: { type: "NotRecognized", value: undefined },
};

/** `Score.Participants` for the game account at the best block, or null when it holds none. */
async function readParticipantAtBest(
  gameAccount: string,
): Promise<RawParticipant | null> {
  const { api } = await getPeopleClient();
  const raw = await withTimeout(
    api.query.Score.Participants.getValue(Enum("Account", gameAccount), { at: "best" }),
    CHAIN_READ_TIMEOUT_MS,
    "Timed out reading the best block.",
  );
  return (raw as RawParticipant | undefined) ?? null;
}

/**
 * The card as a devicehood person who has just signed up should see it.
 *
 * The finalized read finds the sign-up a finality delay after it is in a
 * block. Until it does, a record at best is the participant, and failing that
 * a sign-up Jollity has on the wire, or has seen land, stands for a fresh
 * one. Any state but devicehood is the finalized read's alone.
 */
export function withCandidateOverlay(
  card: HumanityCardResult | undefined,
  bestParticipant: RawParticipant | null | undefined,
  registration: GameRegistration | null,
): HumanityCardResult | undefined {
  if (card?.kind !== "card" || card.state.kind !== "devicehood") return card;
  const wired = registration?.phase === "sent" || registration?.phase === "registered";
  const raw = bestParticipant ?? (wired ? FRESH_PARTICIPANT : null);
  if (raw == null) return card;
  const participant = toHumanityCardParticipant(raw);
  const snapshot = { ...card.snapshot, participant };
  const state = deriveHumanityCardState(snapshot);
  if (state.kind === "devicehood") return card;
  const overlaid: ResolvedHumanityCard = {
    ...card,
    participant,
    participantKey: "account",
    snapshot,
    state,
  };
  return overlaid;
}

/**
 * Moves a devicehood card on to candidate as soon as the sign-up is at best,
 * or on the wire from Jollity, instead of after finality. The finalized card
 * takes over again once it holds the participant.
 */
export function useCandidateOverlay(
  card: HumanityCardResult | undefined,
  enabled = true,
): HumanityCardResult | undefined {
  const devicehood = card?.kind === "card" && card.state.kind === "devicehood";
  const gameAccount =
    card?.kind === "card" ? card.playerIdentities.accountAddress : null;
  const watching = enabled && devicehood;
  const registration = useGameRegistration(watching).data;
  const best = useQuery({
    queryKey: ["chain", "participant-best", gameAccount ?? ""],
    enabled: watching,
    retry: false,
    staleTime: 0,
    refetchInterval:
      registration != null && registration.phase !== "failed"
        ? BEST_POLL_SIGNUP_MS
        : BEST_POLL_IDLE_MS,
    queryFn: gameAccount == null ? skipToken : () => readParticipantAtBest(gameAccount),
  });
  const bestParticipant = watching ? best.data : null;
  return useMemo(
    () => withCandidateOverlay(card, bestParticipant, watching ? registration : null),
    [card, bestParticipant, registration, watching],
  );
}
