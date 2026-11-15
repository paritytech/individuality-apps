// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Manual `Score.register` for the debug panel.
 *
 * Runs the very attempt the home's automatic gate runs
 * (`attemptPersonhoodRegistration`), but straight away: no card-state check,
 * no once-per-launch guard, no backoff record in the way. It still shares the
 * automatic path's mutation key, so the two are never in flight together, and
 * it still writes the record, so the automatic path does not resend after it.
 *
 * Also shows what the automatic gate last decided, the latest run's stages
 * and outcome, the record the gate reads (with a way to clear it), and the
 * configured game account with its `Score.Participants` standing.
 */
import { useState, useSyncExternalStore } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  registrationDiagnostics,
  subscribeRegistrationDiagnostics,
} from "@features/card/chain/registration-diagnostics.ts";
import {
  attemptPersonhoodRegistration,
  REGISTER_PERSONHOOD_MUTATION_KEY,
} from "@features/card/hooks/use-auto-register-personhood.ts";
import {
  clearPersonhoodRegistration,
  readPersonhoodRegistration,
} from "@features/card/storage/personhood-registration-store.ts";
import { GAME_ACCOUNT_INDEX } from "@humanity/shared/identity/game-account.ts";

import { errorText } from "./debug-format.ts";
import { probeGameAccount } from "./debug-registration.ts";
import type { DebugPageInput } from "./debug-view.ts";

const TITLE = "Register membership (Score.register)";

export function DebugRegisterPersonhood({ card }: { card: DebugPageInput["card"] }) {
  const queryClient = useQueryClient();
  const diagnostics = useSyncExternalStore(
    subscribeRegistrationDiagnostics,
    registrationDiagnostics,
    registrationDiagnostics,
  );
  // Bumped to re-read the record after clearing it: the record is a plain
  // `localStorage` value, not React state.
  const [, setRecordVersion] = useState(0);
  const inFlight = useIsMutating({ mutationKey: REGISTER_PERSONHOOD_MUTATION_KEY }) > 0;
  const owner = card?.kind === "card" ? card.accountAddress : null;
  const playAccount = card?.kind === "card" ? (card.playerIdentities?.accountAddress ?? null) : null;

  const account = useQuery({
    queryKey: ["debug", "registration-game-account"],
    queryFn: probeGameAccount,
    retry: false,
  });
  const run = useMutation({
    mutationKey: REGISTER_PERSONHOOD_MUTATION_KEY,
    mutationFn: (target: string) =>
      attemptPersonhoodRegistration(target, { source: "manual", playAccount }),
    onSettled: () => {
      setRecordVersion((version) => version + 1);
      void queryClient.invalidateQueries({ queryKey: ["chain", "humanity-card"] });
      void queryClient.invalidateQueries({ queryKey: ["debug", "registration-game-account"] });
    },
  });

  const record = owner == null ? null : readPersonhoodRegistration(owner);
  const { gate, run: last } = diagnostics;

  return (
    <div className="debug-mutation" data-testid="debug-register-personhood">
      <h3>{TITLE}</h3>
      <p className="debug-note">
        Runs the automatic path's attempt now, ignoring card state, the once-per-launch guard and
        the backoff record. Never while another registration is in flight.
      </p>
      <p className="debug-note">
        auto gate: {gate == null ? "not evaluated yet" : `${gate.kind} — ${gate.detail}`}
      </p>
      <p className="debug-note">
        record:{" "}
        {owner == null
          ? "no card"
          : record == null
            ? "none"
            : JSON.stringify(record)}
      </p>
      {owner != null && record != null && (
        <button
          type="button"
          className="debug-chip"
          disabled={inFlight}
          onClick={() => {
            clearPersonhoodRegistration(owner);
            setRecordVersion((version) => version + 1);
          }}
        >
          Clear record
        </button>
      )}
      <p className="debug-note">
        game account index {GAME_ACCOUNT_INDEX} (config):{" "}
        {account.isPending
          ? "reading…"
          : account.error != null
            ? errorText(account.error)
            : `${account.data.address ?? "—"} — ${account.data.participant}${account.data.readyToRegister ? " · READY" : ""}`}
      </p>
      <p className="debug-note">
        card plays as {playAccount ?? "—"}
        {playAccount != null && account.data?.address != null && playAccount !== account.data.address
          ? " · DIFFERENT from the game account"
          : ""}
      </p>
      <button
        type="button"
        className="debug-chip"
        disabled={owner == null || inFlight}
        onClick={() => {
          if (owner != null) run.mutate(owner);
        }}
      >
        {inFlight ? "Registering…" : `Register now (index ${GAME_ACCOUNT_INDEX})`}
      </button>
      {last != null && (
        <>
          <p className="debug-note">
            last run: {last.source},{" "}
            {new Date(last.startedAt).toLocaleTimeString()}
          </p>
          {last.stages.map((stage, position) => (
            <p key={position} className="debug-note">
              · {stage}
            </p>
          ))}
          {last.outcome == null ? (
            <p className="debug-note">running…</p>
          ) : (
            <p className={last.outcome.kind === "registered" ? "debug-note" : "debug-warn"}>
              {last.outcome.kind}: {last.outcome.detail}
              {last.outcome.txHash == null ? "" : ` · ${last.outcome.txHash}`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
