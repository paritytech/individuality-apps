// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Manual triggers for the app's real chain mutations.
 *
 * Unlike the rest of the panel, this section WRITES. It exists because these
 * mutations sit behind state that is awkward to reach on demand — a lite card
 * caught mid-promotion, an open draw, a draw this person actually won — so
 * exercising them otherwise means waiting for the chain and a manager origin to
 * produce the right moment together.
 *
 * The airdrop triggers target `PeopleAirdrops`, which schedules and draws
 * independently of the weekly game: there is no game index or per-game airdrop
 * index in a draw's identity, so a draw index (or its event id) is the whole
 * reference. The older `Game.claim_airdrop` daily-dollar path this pallet
 * replaced is gone from the app.
 *
 * Dev-only: `DebugPanel` mounts this behind `VITE_DEBUG_PANEL`, which folds at
 * build time.
 */
import { useState } from "react";

import { useLiteUsernameUpgrade } from "@features/card/hooks/use-lite-username-upgrade.ts";
import type { UsernameUpgradeMethod } from "@features/card/chain/upgrade-lite-username.ts";

import {
  ClaimDrawMutation,
  RegisterDrawsMutation,
  TopUpCoinageMutation,
} from "./DebugAirdropMutations.tsx";
import { Field, Outcome, useRecordSettle } from "./DebugMutationParts.tsx";
import { DebugDotnsName } from "./DebugDotnsName.tsx";
import { DebugRegisterPersonhood } from "./DebugRegisterPersonhood.tsx";
import { errorText } from "./debug-format.ts";
import { recordMutation } from "./debug-mutation-journal.ts";
import { upgradeTarget } from "./debug-mutations.ts";
import type { DebugPageInput } from "./debug-view.ts";

/**
 * Both routes to a full username, as separate mutations with separate state.
 *
 * The submitted call is the same either way — `Resources.register_person` with
 * a signed origin carrying `AsPersonalAliasWithAccount`. They differ in one
 * step before it: `truapi` first submits `People.set_alias_account`, authorized
 * by a ring-VRF proof built inside a custom signer, to create the
 * `People.AccountToAlias` row the origin resolves from. `product-sdk` skips
 * that, so running each isolates whether the missing binding is the whole
 * difference.
 */
const METHODS = [
  {
    method: "product-sdk" as const,
    label: "product-sdk",
    note: "register_person only — needs the alias already bound",
  },
  {
    method: "truapi" as const,
    label: "truAPI",
    note: "binds the Resources alias first, then register_person",
  },
];

function UpgradeMutation({
  card,
  method,
  label,
  note,
}: {
  card: DebugPageInput["card"];
  method: UsernameUpgradeMethod;
  label: string;
  note: string;
}) {
  const [fullUsername, setFullUsername] = useState("");
  const upgrade = useLiteUsernameUpgrade();
  const target = upgradeTarget(card);
  const journalKey = `Resources.register_person (${label})`;
  const result =
    upgrade.data == null ? null : `${upgrade.data.status} · ${upgrade.data.txHash}`;

  useRecordSettle(
    journalKey,
    upgrade.error != null
      ? "failed"
      : upgrade.data?.status === "included"
        ? "finalized"
        : (upgrade.data?.status ?? null),
    upgrade.error != null ? errorText(upgrade.error) : result ?? "",
  );

  return (
    <div className="debug-mutation">
      <h3>{journalKey}</h3>
      <p className="debug-note">{note}</p>
      {target.kind === "blocked" ? (
        <p className="debug-note">unavailable — {target.reason}</p>
      ) : (
        <>
          <p className="debug-note">
            {target.currentLiteUsername} · owner {target.expectedLiteAddress.slice(0, 10)}…
          </p>
          <Field
            label="new username"
            value={fullUsername}
            placeholder="6-32 lowercase letters"
            onChange={setFullUsername}
          />
          <button
            type="button"
            className="debug-chip"
            disabled={upgrade.isPending || fullUsername.trim() === ""}
            onClick={() => {
              const name = fullUsername.trim();
              recordMutation(
                journalKey,
                "submitted",
                `${target.currentLiteUsername} → ${name}`,
              );
              upgrade.submit({
                expectedLiteAddress: target.expectedLiteAddress,
                currentLiteUsername: target.currentLiteUsername,
                fullUsername: name,
                method,
              });
            }}
          >
            Claim via {label}
          </button>
        </>
      )}
      <Outcome pending={upgrade.isPending} error={upgrade.error} result={result} />
    </div>
  );
}

export function DebugMutations({ input }: { input: DebugPageInput }) {
  return (
    <section className="debug-section">
      <p className="debug-warn">
        Signs and submits for real on {input.network || "(default)"}.
      </p>
      <DebugRegisterPersonhood card={input.card} />
      <DebugDotnsName card={input.card} />
      {METHODS.map((entry) => (
        <UpgradeMutation
          key={entry.method}
          card={input.card}
          method={entry.method}
          label={entry.label}
          note={entry.note}
        />
      ))}
      <RegisterDrawsMutation input={input} />
      <ClaimDrawMutation input={input} />
      <TopUpCoinageMutation input={input} />
    </section>
  );
}
