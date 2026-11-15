// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Send `Score.register` by itself once the card has cleared the threshold.
 *
 * The iOS wallet used to send it and no longer does; nobody taps for it now.
 * Mounted beside the card read and the promotion tracker (`PrizePage`), so
 * the moment the registration lands and the card reads `member`, the
 * promotion plays and the name claim follows.
 *
 * Never twice at once: none while one is in flight, and none while the
 * per-person record says one is on its way
 * (`personhood-registration-store.ts`) — that survives a reload. A stop is
 * retried by itself for as long as the app is open, after a short capped
 * backoff (`personhood-registration.ts`), and the chain is re-read before
 * anything is sent (`registerPersonhood`). The home only ever says the
 * membership is being finished; why an attempt stopped goes to the log and
 * the debug panel.
 */
import { useEffect, useReducer } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";

import {
  registerPersonhood,
  type RegisterPersonhoodOutcome,
} from "@features/card/chain/register-personhood.ts";
import {
  nextAttemptAt,
  readyToFinishMembership,
  registrationGate,
  type PersonhoodRegistrationRecord,
  type RegistrationStopKind,
} from "@features/card/domain/personhood-registration.ts";
import {
  finishRegistrationRun,
  recordRegistrationGate,
  recordRegistrationStage,
  startRegistrationRun,
} from "@features/card/chain/registration-diagnostics.ts";
import {
  clearPersonhoodRegistration,
  readPersonhoodRegistration,
  writePersonhoodRegistration,
} from "@features/card/storage/personhood-registration-store.ts";
import { recordMutation } from "@features/debug/debug-mutation-journal.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { describeError } from "@humanity/shared/chain/error-detail.ts";
import {
  GAME_ACCOUNT_INDEX,
  resolveGameAccount,
} from "@humanity/shared/identity/game-account.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { membershipRootPending } from "@humanity/shared/card/username-claim.ts";
import { runFlow, type FlowRun } from "@humanity/shared/telemetry/flow.ts";

const logger = loggerFor("card", "register-personhood");

const SCORE_REGISTER = "Score.register";

/** Shared so a remounted page still sees a registration in flight. */
export const REGISTER_PERSONHOOD_MUTATION_KEY = ["card", "register-personhood"] as const;

export const FINISHING_MEMBERSHIP_NOTE = "Finishing your membership…";
const PREPARING_MEMBERSHIP_NOTE = "Preparing your membership…";
/** The score has recognised the person and their key is queued for the
 *  Membership ring, which the chain only rebuilds once the game's reporting
 *  has ended: nothing this app sends shortens that wait. */
export const WAITING_FOR_RING_NOTE = "Finishing your membership, this can take a while…";

/** A chain that says not ready while the card says ready waits this long
 *  for the card to catch up before asking again. */
const NOT_READY_PAUSE_MS = 60_000;

/** Per-owner hold for this launch (the gate's `pausedUntil`), for outcomes
 *  the record does not keep. Set to forever the moment an attempt fires, so
 *  two mounted pages acting on one "firing" render never both send, then
 *  settled by the outcome. Module state, so it outlives a remount. */
const pausedUntil = new Map<string, number>();
/** The last gate decision logged, so the log gets one line per change of
 *  inputs rather than one per render. Module state for the same reason. */
let lastGateLogged = "";

export function resetAutoRegisterPersonhoodForTests(): void {
  pausedUntil.clear();
  lastGateLogged = "";
}

export type AttemptOutcome =
  | RegisterPersonhoodOutcome
  | { kind: "no-candidate"; detail: string }
  | { kind: "threw"; detail: string };

export interface RegistrationAttemptOptions {
  source: "auto" | "manual";
  /** The account the card reads the game on (`playerIdentities`), logged
   *  beside the candidate so a mismatch is visible. */
  playAccount?: string | null;
}

function stoppedAfter(
  previous: PersonhoodRegistrationRecord | null,
  candidate: string | null,
  kind: RegistrationStopKind,
): PersonhoodRegistrationRecord {
  return {
    status: "stopped",
    candidate,
    at: Date.now(),
    kind,
    attempts: previous?.status === "stopped" ? previous.attempts + 1 : 1,
  };
}

/**
 * One registration attempt for `owner`, writing the never-twice record, the
 * mutation journal and the panel's run diagnostics. Shared by the automatic
 * gate and the debug panel's manual trigger; callers run it under
 * {@link REGISTER_PERSONHOOD_MUTATION_KEY} so the two are never in flight
 * together.
 */
export function attemptPersonhoodRegistration(
  owner: string,
  options: RegistrationAttemptOptions,
): Promise<AttemptOutcome> {
  return runFlow("membership.promotion", (flow) => runAttempt(owner, options, flow), {
    attributes: { source: options.source, "game.account.index": GAME_ACCOUNT_INDEX },
    // A stop that sent nothing because the chain said so is the flow doing
    // its job; everything else is the person not finishing Membership.
    outcome: ({ kind }) => ({
      kind,
      ok: kind === "registered" || kind === "not-ready" || kind === "not-personhood-product",
    }),
  });
}

async function runAttempt(
  owner: string,
  { source, playAccount = null }: RegistrationAttemptOptions,
  flow: FlowRun,
): Promise<AttemptOutcome> {
  const previous = readPersonhoodRegistration(owner);
  startRegistrationRun(source);
  const finish = (outcome: AttemptOutcome): AttemptOutcome => {
    finishRegistrationRun({
      kind: outcome.kind,
      detail: outcome.kind === "registered" ? `${outcome.confirmed ? "finalized" : "unconfirmed"}` : outcome.detail,
      ...(outcome.kind === "registered" ? { txHash: outcome.txHash } : {}),
    });
    logger.info("{source} registration settled as {kind}", { source, kind: outcome.kind });
    return outcome;
  };
  try {
    const candidate = await resolveGameAccount();
    if (candidate == null) {
      const detail = `the game account at index ${GAME_ACCOUNT_INDEX} did not resolve`;
      logger.error("stage candidate: {detail}", { detail });
      writePersonhoodRegistration(owner, stoppedAfter(previous, null, "failed"));
      recordMutation(SCORE_REGISTER, "rejected", detail);
      return finish({ kind: "no-candidate", detail });
    }
    logger.info(
      "stage candidate: {source} run registers index {index} {candidate}; the card plays as " +
        "{playAccount} ({relation})",
      {
        source,
        index: GAME_ACCOUNT_INDEX,
        candidate: candidate.address,
        playAccount: playAccount ?? "unknown",
        relation:
          playAccount == null
            ? "not known"
            : playAccount === candidate.address
              ? "same account"
              : "DIFFERENT: the card was read on another account",
      },
    );
    // Written before anything reaches the host: a reload from here on finds a
    // registration on its way, not a blank slate to send again.
    writePersonhoodRegistration(owner, {
      status: "sending",
      candidate: candidate.address,
      at: Date.now(),
    });
    recordMutation(SCORE_REGISTER, "submitted", `${source} index ${GAME_ACCOUNT_INDEX} ${candidate.address}`);
    const { api, client, network } = await getPeopleClient();
    const outcome = await registerPersonhood({
      api,
      client,
      network,
      candidate,
      onStage: (stage) => {
        recordRegistrationStage(stage);
        // The panel reads the whole line; the span only its stable head
        // ("sign", "broadcast"), never the address or hash that follows.
        flow.stage(stage.split(/[\s:]/, 1)[0] ?? stage);
      },
    });
    switch (outcome.kind) {
      case "registered":
        flow.set({ "tx.confirmed": outcome.confirmed });
        writePersonhoodRegistration(owner, {
          status: "sent",
          candidate: candidate.address,
          at: Date.now(),
          txHash: outcome.txHash,
        });
        recordMutation(
          SCORE_REGISTER,
          outcome.confirmed ? "finalized" : "unknown",
          `${candidate.address} ${outcome.txHash}`,
        );
        break;
      case "not-ready":
      case "not-personhood-product":
        // Nothing was sent: whatever stood before this attempt still stands.
        if (previous == null) clearPersonhoodRegistration(owner);
        else writePersonhoodRegistration(owner, previous);
        recordMutation(SCORE_REGISTER, "rejected", `${outcome.kind}: ${outcome.detail}`);
        break;
      default:
        writePersonhoodRegistration(owner, stoppedAfter(previous, candidate.address, outcome.kind));
        recordMutation(
          SCORE_REGISTER,
          outcome.kind === "failed" ? "failed" : "rejected",
          `${outcome.kind}: ${outcome.detail}`,
        );
    }
    return finish(outcome);
  } catch (error) {
    const detail = describeError(error);
    writePersonhoodRegistration(
      owner,
      stoppedAfter(previous, readPersonhoodRegistration(owner)?.candidate ?? null, "failed"),
    );
    recordMutation(SCORE_REGISTER, "failed", detail);
    logger.error("{source} registration threw: {detail}", { source, detail });
    return finish({ kind: "threw", detail });
  }
}

/**
 * Fire the registration for a card that has cleared the threshold, retry it
 * until it lands, and say where it stands: `null` when there is nothing to
 * say, else the one quiet line the home shows under the card. `live` is
 * false on demo and fixture pages, which never send anything.
 */
export function useAutoRegisterPersonhood(
  card: HumanityCardResult | undefined,
  live: boolean,
): string | null {
  const queryClient = useQueryClient();
  // Read off the mutation cache, not the observer: an attempt started from
  // an effect can outlive the observer that started it (a remount, or
  // StrictMode's effect replay), which then never hears it settle.
  const busy = useIsMutating({ mutationKey: REGISTER_PERSONHOOD_MUTATION_KEY }) > 0;
  const { mutate } = useMutation<AttemptOutcome, unknown, { owner: string; playAccount: string }>({
    mutationKey: REGISTER_PERSONHOOD_MUTATION_KEY,
    // The hold is settled here, not in `onSuccess`: the attempt can outlive
    // the observer that started it.
    mutationFn: async ({ owner, playAccount }) => {
      const outcome = await attemptPersonhoodRegistration(owner, { source: "auto", playAccount });
      if (outcome.kind === "not-ready") pausedUntil.set(owner, Date.now() + NOT_READY_PAUSE_MS);
      // A preview deploy never may send: keep the forever hold.
      else if (outcome.kind !== "not-personhood-product") pausedUntil.delete(owner);
      return outcome;
    },
    onSuccess: (outcome) => {
      if (outcome.kind === "registered") {
        void queryClient.invalidateQueries({ queryKey: ["chain", "humanity-card"] });
      }
    },
  });
  // Re-renders when a hold runs out, so the retry fires without a relaunch;
  // `tick` re-arms the timer should it fire a hair early.
  const [tick, wake] = useReducer((n: number) => n + 1, 0);

  const resolved = live && card?.kind === "card" ? card : null;
  const owner = resolved?.accountAddress ?? null;
  // Optional on purpose: a card hydrated from an older persisted cache can
  // predate `playerIdentities`, and the gate must never throw over a field
  // it only logs.
  const playAccount = resolved?.playerIdentities?.accountAddress ?? "";
  const record = owner == null ? null : readPersonhoodRegistration(owner);
  const paused = owner == null ? 0 : (pausedUntil.get(owner) ?? 0);
  const gate = registrationGate({
    live,
    card:
      card?.kind === "card"
        ? { kind: "card", owner: card.accountAddress, state: card.state, playAccount }
        : card,
    busy,
    pausedUntil: paused,
    record,
    now: Date.now(),
  });
  const wakeAt = gate.kind === "holding" ? nextAttemptAt(record) : gate.kind === "paused" ? paused : 0;

  useEffect(() => {
    const signature = `${gate.kind}|${gate.detail}`;
    if (signature !== lastGateLogged) {
      lastGateLogged = signature;
      recordRegistrationGate(gate);
      logger.info("stage gate: {kind}; {detail}", { kind: gate.kind, detail: gate.detail });
    }
    if (owner == null || gate.kind !== "firing") return;
    // Checked again here, not only in the gate: the gate was computed at
    // render, and two mounted pages (or an effect replay) can both act on
    // one "firing" render before either registers its mutation.
    if ((pausedUntil.get(owner) ?? 0) > Date.now()) return;
    pausedUntil.set(owner, Number.POSITIVE_INFINITY);
    mutate({ owner, playAccount });
  }, [gate.kind, gate.detail, owner, playAccount, mutate]);

  useEffect(() => {
    if (!Number.isFinite(wakeAt) || wakeAt <= 0) return;
    const timer = setTimeout(wake, Math.max(wakeAt - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [wakeAt, tick]);

  if (resolved != null && resolved.state.kind === "member" && membershipRootPending(resolved)) {
    return PREPARING_MEMBERSHIP_NOTE;
  }
  if (resolved == null || !readyToFinishMembership(resolved.state)) return null;
  if (resolved.membershipStanding?.position.kind === "onboarding") return WAITING_FOR_RING_NOTE;
  return busy || record != null ? FINISHING_MEMBERSHIP_NOTE : null;
}
