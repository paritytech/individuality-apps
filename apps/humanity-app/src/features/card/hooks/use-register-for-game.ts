// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import { SeatUnfundedError } from "@individuality/sign-up";

import { createGameSignUp, type GameSignUp } from "@features/card/chain/game-sign-up.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import { signUpWords } from "@features/card/domain/sign-up-words.ts";
import { useGameRegistration } from "@features/card/hooks/use-game-registration.ts";
import { recordMutation } from "@features/debug/debug-mutation-journal.ts";
import { describeError } from "@humanity/shared/chain/error-detail.ts";
import { GameRegistrationError } from "@humanity/shared/chain/individuality.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("card", "register-for-game");

/**
 * Journalled as well as logged: the 200-record log buffer rolls over long
 * before a person gets around to pasting a debug snapshot, and the journal is
 * the only place a failed sign-up still names itself afterwards.
 */
const SIGN_UP = "Game.sign_up_with_account_lite_invite";

/** How a name link ends when this product cannot get past it alone: the game
 *  account has no PGAS (the host funds only a product's own accounts), or
 *  there is no username or game account to link. Jollity can, as itself. */
const HAND_OFF: ReadonlySet<string> = new Set(["unfunded", "skipped"]);

/** Why a tap ended before the flow took it on: the two the person can act
 *  on get their own sentence, anything else is "try again". */
function tapRefusal(error: unknown): string {
  if (error instanceof SeatUnfundedError) return "Your game account can't cover this sign-up right now.";
  if (error instanceof GameRegistrationError && error.code === "SigningRejected") return "You cancelled the approval.";
  return "We couldn't register you for this game. Try again shortly.";
}

export interface RegisterForGameState {
  register: () => void;
  registering: boolean;
  /** The held button's label when it is not "Registering…"; null otherwise. */
  registeringLabel: string | null;
  error: string | null;
}

/**
 * Sign the game account up for the running game, from here, on the flow
 * Jollity's app runs (`chain/game-sign-up.ts`). `seatAccount` is the
 * `dim2.<tld>` account the card reads; `game` is the card's game read, which
 * tells the flow which game is open and whether the account is in it.
 *
 * While registration is open the seat is prepared in the background, as in
 * Jollity: the free seat's bind and the name link, so the tap goes straight
 * through. A tap the name link cannot carry from here, or a host that cannot
 * sign the game account up, goes to Jollity instead (`handOff`). A landed
 * sign-up refreshes the game read, which turns "Register" into "Registered".
 */
export function useRegisterForGame(
  seatAccount: string | null,
  game: CurrentGameResult | null | undefined,
  handOff: () => void,
): RegisterForGameState {
  const queryClient = useQueryClient();
  const [signUp, setSignUp] = useState<GameSignUp | null>(null);
  /** No sign-up from this host: Register hands off to Jollity. */
  const [unavailable, setUnavailable] = useState(false);
  /** The last tap's refusal, until the next tap. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [, changed] = useReducer((count: number) => count + 1, 0);
  const handOffRef = useRef(handOff);
  /** A tap still being seen through, which may still be handed off. */
  const tapped = useRef(false);
  /** A sign-up from here is on the wire, until the chain's row shows it. */
  const sent = useRef(false);

  useEffect(() => {
    handOffRef.current = handOff;
  });

  // One flow per game account, for as long as the home shows it.
  useEffect(() => {
    if (seatAccount == null) return;
    let live = true;
    let created: GameSignUp | null = null;
    setUnavailable(false);
    createGameSignUp(seatAccount)
      .then((next) => {
        if (!live) {
          next?.flow.cancelRegister();
          return;
        }
        created = next;
        setSignUp(next);
        setUnavailable(next == null);
      })
      .catch((error: unknown) => {
        logger.error("the sign-up could not start: {detail}", { detail: describeError(error) });
        if (live) setUnavailable(true);
      });
    return () => {
      live = false;
      tapped.current = false;
      setSignUp(null);
      created?.flow.cancelRegister();
    };
  }, [seatAccount]);

  // Every move of the flow re-renders the block; the landing refreshes the game read.
  useEffect(() => {
    if (signUp == null) return;
    const { flow } = signUp;
    let landed = flow.optimistic().registered;
    let phase = flow.phase();
    const onChange = () => {
      const now = flow.optimistic().registered;
      // On the wire it counts as in; the chain confirms it, or the flow takes it back.
      if (now && !landed) {
        tapped.current = false;
        sent.current = true;
        recordMutation(SIGN_UP, "unknown", seatAccount ?? "-");
        void queryClient.invalidateQueries({ queryKey: ["chain", "current-game"] });
      }
      landed = now;
      const next = flow.phase();
      if (next !== phase && (next === "refused" || next === "closed")) {
        tapped.current = false;
        recordMutation(SIGN_UP, "failed", next);
      }
      phase = next;
      changed();
    };
    const stopChange = flow.onChange(onChange);
    const stopSeat = flow.onSeatInput(changed);
    return () => {
      stopChange();
      stopSeat();
    };
  }, [signUp, queryClient, seatAccount]);

  // The sign-up record, Jollity's or this home's own from before a reload, read
  // from both products' storage: the flow starts none over one that is
  // registering for the same game.
  const { data: recorded } = useGameRegistration(seatAccount != null);
  useEffect(() => {
    signUp?.flow.setRegistration(recorded);
  }, [signUp, recorded]);

  // The game the flow signs up for: the slot, its window while registration
  // is open, and a new slot when the index moves.
  const slot = game?.kind === "game" ? game : null;
  const index = slot?.gameIndex;
  const open = slot?.phase.label === "registration";
  const registrationEnds = slot?.registrationEndsSeconds;
  const gamePlayTime = slot?.gameDateSeconds;
  const registered = slot?.registered === true;
  const lastSlot = useRef<{ signUp: GameSignUp; index: number | undefined } | null>(null);
  useEffect(() => {
    if (signUp == null) return;
    const { flow } = signUp;
    flow.setSlot(
      index,
      open && index !== undefined && registrationEnds !== undefined && gamePlayTime !== undefined
        ? { index, registrationEnds, gamePlayTime }
        : undefined,
    );
    if (lastSlot.current?.signUp !== signUp || lastSlot.current.index !== index) {
      lastSlot.current = { signUp, index };
      flow.newSlot(index);
    }
  }, [signUp, index, open, registrationEnds, gamePlayTime]);

  useEffect(() => {
    if (signUp == null || !registered) return;
    signUp.flow.confirmRegistered();
    if (sent.current) {
      sent.current = false;
      recordMutation(SIGN_UP, "finalized", seatAccount ?? "-");
    }
  }, [signUp, registered, index, seatAccount]);

  // The seat, prepared while registration is open: the name link, and the
  // free seat's bind when the seat is not bound yet. Again on every seat input
  // (the bind or the link landing, or failing and due again).
  useEffect(() => {
    if (signUp == null || !open || registered) return;
    const { flow } = signUp;
    let live = true;
    const prepare = () => {
      flow.requestName();
      void flow
        .readSeat()
        .then((value) => {
          if (live && value.seat.path === "free" && !value.seat.ready) flow.requestBind();
        })
        .catch((error: unknown) => {
          logger.warning("seat read failed: {detail}", { detail: describeError(error) });
        });
    };
    prepare();
    const stop = flow.onSeatInput(prepare);
    return () => {
      live = false;
      stop();
    };
  }, [signUp, open, registered, index]);

  const nameOutcome = signUp?.nameOutcome() ?? null;
  const waitingOnName = signUp?.flow.waitingOn() === "name";
  // A tap held on a name this product cannot link goes to Jollity.
  useEffect(() => {
    if (signUp == null || !tapped.current || !waitingOnName || !HAND_OFF.has(nameOutcome ?? "")) return;
    tapped.current = false;
    logger.info("the name can't be linked from here ({outcome}): Jollity takes the sign-up", {
      outcome: nameOutcome,
    });
    signUp.flow.cancelRegister();
    handOffRef.current();
  }, [signUp, waitingOnName, nameOutcome]);

  const words = signUpWords(signUp?.flow.phase() ?? "idle");
  return {
    register: () => {
      if (unavailable) {
        handOffRef.current();
        return;
      }
      const register = signUp?.flow.register;
      // Still starting: the host's answer is on its way.
      if (signUp == null || register == null || signUp.flow.signingUp()) return;
      if (HAND_OFF.has(signUp.nameOutcome() ?? "")) {
        logger.info("the name can't be linked from here ({outcome}): Jollity takes the sign-up", {
          outcome: signUp.nameOutcome(),
        });
        handOffRef.current();
        return;
      }
      tapped.current = true;
      setRefusal(null);
      recordMutation(SIGN_UP, "submitted", seatAccount ?? "-");
      register().catch((error: unknown) => {
        tapped.current = false;
        setRefusal(tapRefusal(error));
        recordMutation(SIGN_UP, "rejected", describeError(error));
        logger.warning("game sign-up refused: {detail}", { detail: describeError(error) });
      });
    },
    registering: words.registering || (signUp?.flow.signingUp() ?? false),
    registeringLabel: words.label,
    error: words.note ?? refusal,
  };
}
