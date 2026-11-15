// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Manual triggers for the two people-airdrops extrinsics a person can send,
 * plus the host top-up that moves a claimed prize on into the coinage purse.
 *
 * A draw is identified only by the pallet's `NextDrawIndex` at scheduling time,
 * so a draw index (or its full event id) is the whole reference — there is no
 * game index and no per-game airdrop index, because this pallet schedules and
 * draws independently of the weekly game.
 *
 * `claim` goes through the production hook with a real `AirdropParticipation`
 * taken from the standing the panel already holds, so it banks the payout and
 * refreshes the standing exactly as the prize page does. `register` cannot:
 * `useAutoRegisterDraws` is a background sweep with a module-level attempted-id
 * ledger that no button can re-fire, so this calls `registerForDraws` — the
 * same chain function that hook calls, one level down, never `api.tx` — and
 * invalidates the standing itself. `top up`'s production path is the
 * post-claim sweep in `useClaimAirdropPrize` (`sweepPrizeIntoCoinage`); this
 * button is the manual/recovery path for a prize that sweep left behind, so it
 * calls the host directly and reports through the coinage balance section.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { PRIZE_ACCOUNT_INDEX } from "@features/prize/chain/prize-account.ts";
import {
  forgetNotAttestedDevice,
  registerForDraws,
} from "@humanity/shared/airdrops/chain/register-draws.ts";
import { AIRDROP_STANDING_QUERY_KEY } from "@features/airdrops/hooks/use-airdrop-standing.ts";
import { useClaimAirdropPrize } from "@features/airdrops/hooks/use-claim-airdrop-prize.ts";
import { topUpCoinageFromProductAccount } from "@humanity/shared/chain/coinage-top-up.ts";
import { formatPrizeDollars } from "@humanity/shared/domain/prize-money.ts";

import {
  airdropTarget,
  claimPrefill,
  findParticipation,
  openDraws,
  registerPrefill,
  topUpPrefill,
} from "./debug-airdrop-targets.ts";
import { Field, Outcome, useRecordSettle } from "./DebugMutationParts.tsx";
import { errorText } from "./debug-format.ts";
import { recordMutation } from "./debug-mutation-journal.ts";
import { parseBaseUnits, parseDrawRef, parseDrawRefs } from "./debug-mutations.ts";
import type { DebugPageInput } from "./debug-view.ts";

const REGISTER = "PeopleAirdrops.register";
const CLAIM = "PeopleAirdrops.claim";
const TOP_UP = "Payment.topUp";

/** Edits layer over the live prefill, so a prefill keeps tracking the standing
 *  until the operator overrides it by hand. */
function useDrawField(prefill: string) {
  const [edit, setEdit] = useState<string | null>(null);
  return { value: edit ?? prefill, set: setEdit };
}

export function RegisterDrawsMutation({ input }: { input: DebugPageInput }) {
  const target = airdropTarget(input);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const prefill =
    target.kind === "ready" ? registerPrefill(target.standing, nowSeconds) : "";
  const draws = useDrawField(prefill);
  const [problem, setProblem] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const register = useMutation({
    // A hand-triggered attempt always asks the host again, memo or not.
    mutationFn: (args: Parameters<typeof registerForDraws>[0]) => {
      forgetNotAttestedDevice();
      return registerForDraws(args);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AIRDROP_STANDING_QUERY_KEY });
    },
  });

  // Per chunk: `registerForDraws` splits the list to the runtime's
  // MaxRegisterBatch and each chunk is its own extrinsic that can fail alone.
  const result =
    register.data == null
      ? null
      : register.data.map((chunk) => `${chunk.eventIds.length}× ${chunk.status}`).join(" · ");
  const chunkError = register.data?.find((chunk) => chunk.error != null)?.error;
  const failure = register.error ?? chunkError;

  useRecordSettle(
    REGISTER,
    failure != null ? "failed" : register.data != null ? "finalized" : null,
    failure != null ? errorText(failure) : result ?? "",
  );

  return (
    <div className="debug-mutation">
      <h3>PeopleAirdrops.register</h3>
      {target.kind === "blocked" ? (
        <p className="debug-note">unavailable — {target.reason}</p>
      ) : (
        <>
          <p className="debug-note">
            {prefill === "" ? "no draws pending registration" : `pending: ${prefill}`}
          </p>
          {target.kind === "ready" && (
            <div className="debug-flows">
              {openDraws(target.standing, nowSeconds).map((draw) => (
                <button
                  key={draw.eventId}
                  type="button"
                  className="debug-chip"
                  disabled={register.isPending}
                  title={`closes ${new Date(draw.closesAt * 1000).toISOString().slice(11, 19)}Z`}
                  onClick={() => {
                    recordMutation(REGISTER, "submitted", draw.eventId);
                    register.mutate({ eventIds: [draw.eventId] });
                  }}
                >
                  {`Register #${draw.drawIndex}${draw.registered === true ? " (in)" : ""}`}
                </button>
              ))}
            </div>
          )}
          <Field
            label="draws"
            value={draws.value}
            placeholder="indices or event ids"
            onChange={(value) => {
              setProblem(null);
              draws.set(value);
            }}
          />
          <button
            type="button"
            className="debug-chip"
            disabled={register.isPending}
            onClick={() => {
              const parsed = parseDrawRefs(draws.value);
              setProblem(parsed.ok ? null : parsed.problem);
              if (!parsed.ok) {
                recordMutation(REGISTER, "rejected", parsed.problem);
                return;
              }
              recordMutation(REGISTER, "submitted", parsed.eventIds.join(" "));
              register.mutate({ eventIds: parsed.eventIds });
            }}
          >
            Register for draws
          </button>
        </>
      )}
      {problem == null ? null : <p className="debug-warn">{problem}</p>}
      <Outcome
        pending={register.isPending}
        error={failure}
        result={result}
      />
    </div>
  );
}

export function ClaimDrawMutation({ input }: { input: DebugPageInput }) {
  const target = airdropTarget(input);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const prefill =
    target.kind === "ready" ? claimPrefill(target.standing, nowSeconds) : "";
  const draw = useDrawField(prefill);
  const [problem, setProblem] = useState<string | null>(null);
  const card = input.card;
  const claim = useClaimAirdropPrize(
    card != null && card.kind === "card" ? card.accountAddress : "",
  );

  const parsed = parseDrawRef(draw.value);
  // "0x" matches no draw, so an unparsed field simply reports no status.
  const status = claim.statusFor(parsed.ok ? parsed.eventId : "0x");
  const settled = status.included ? "finalized" : status.unknown ? "unknown" : null;
  const result =
    settled == null ? null : status.txHash == null ? settled : `${settled} · ${status.txHash}`;

  useRecordSettle(
    CLAIM,
    status.error != null ? "failed" : settled,
    status.error != null ? errorText(status.error) : result ?? "",
  );
  return (
    <div className="debug-mutation">
      <h3>PeopleAirdrops.claim</h3>
      {target.kind === "blocked" ? (
        <p className="debug-note">unavailable — {target.reason}</p>
      ) : (
        <>
          <p className="debug-note">
            {prefill === "" ? "no prize claimable now" : `claimable: ${prefill}`}
          </p>
          <Field
            label="draw"
            value={draw.value}
            placeholder="index or 0x… event id"
            onChange={(value) => {
              setProblem(null);
              draw.set(value);
            }}
          />
          <button
            type="button"
            className="debug-chip"
            disabled={status.pending}
            onClick={() => {
              if (!parsed.ok) {
                setProblem(parsed.problem);
                recordMutation(CLAIM, "rejected", `${draw.value.trim()}: ${parsed.problem}`);
                return;
              }
              const participation = findParticipation(target.standing, parsed.eventId);
              if (participation == null) {
                const reason = `draw ${parsed.drawIndex} is not in the standing just read`;
                setProblem(reason);
                recordMutation(CLAIM, "rejected", reason);
                return;
              }
              setProblem(null);
              recordMutation(CLAIM, "submitted", `draw ${parsed.drawIndex}`);
              claim.claim(participation);
            }}
          >
            Claim airdrop
          </button>
        </>
      )}
      {problem == null ? null : <p className="debug-warn">{problem}</p>}
      <Outcome pending={status.pending} error={status.error} result={result} />
    </div>
  );
}

export function TopUpCoinageMutation({ input }: { input: DebugPageInput }) {
  const target = airdropTarget(input);
  const prefill = target.kind === "ready" ? topUpPrefill(target.standing) : "";
  const amount = useDrawField(prefill);
  const [problem, setProblem] = useState<string | null>(null);
  const topUp = useMutation({
    mutationFn: (units: bigint) =>
      topUpCoinageFromProductAccount({
        amount: units,
        derivationIndex: PRIZE_ACCOUNT_INDEX,
      }),
  });

  const parsed = parseBaseUnits(amount.value);
  const result =
    topUp.isSuccess && topUp.variables != null
      ? `sent ${topUp.variables} base units (${formatPrizeDollars(topUp.variables)})`
      : null;

  useRecordSettle(
    TOP_UP,
    topUp.error != null ? "failed" : topUp.isSuccess ? "finalized" : null,
    topUp.error != null ? errorText(topUp.error) : result ?? "",
  );
  return (
    <div className="debug-mutation">
      <h3>Payment.topUp</h3>
      <p className="debug-note">
        from product account #{PRIZE_ACCOUNT_INDEX} (the prize payout account, where a claimed
        dollar lands) into the main coinage purse
      </p>
      <p className="debug-note">
        {prefill === ""
          ? "no won draw on the standing to prefill from"
          : `last won prize: ${prefill} base units (${formatPrizeDollars(BigInt(prefill))})`}
      </p>
      <Field
        label="amount"
        value={amount.value}
        placeholder="base units, e.g. 1_000_000"
        onChange={(value) => {
          setProblem(null);
          amount.set(value);
        }}
      />
      <button
        type="button"
        className="debug-chip"
        disabled={topUp.isPending}
        onClick={() => {
          if (!parsed.ok) {
            setProblem(parsed.problem);
            recordMutation(TOP_UP, "rejected", `${amount.value.trim()}: ${parsed.problem}`);
            return;
          }
          setProblem(null);
          recordMutation(TOP_UP, "submitted", `${parsed.amount} base units`);
          topUp.mutate(parsed.amount);
        }}
      >
        Top up coinage
      </button>
      {problem == null ? null : <p className="debug-warn">{problem}</p>}
      <Outcome pending={topUp.isPending} error={topUp.error} result={result} />
    </div>
  );
}
