// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useState } from "react";

import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { envConfig } from "@humanity/shared/config/env.ts";

import { probeLiteKeyOwners } from "./lite-key-owner-probe.ts";

/**
 * Manual trigger for the lite key owner probe.
 *
 * Never automatic, unlike `useResourcesAliasProbe`: listing a *foreign*
 * owner is host-side consent-gated (a one-time `AccountAccessReview` prompt
 * per requester/target pair), and the panel must never raise that prompt on
 * a render the operator did not ask for. `run` is the only thing that starts
 * a probe.
 *
 * @returns `settled`, a value that changes once the probe settles, to depend
 *   on for a re-render — the diagnostics themselves come from
 *   `getLiteKeyOwnerProbeDiagnostics`, the module write a re-render alone
 *   cannot observe; `pending`, whether a probe is in flight; and `run`,
 *   which starts one against `attestedKey`.
 */
export function useLiteKeyOwnerProbe(): {
  settled: number;
  pending: boolean;
  run: (attestedKey: string) => void;
} {
  const [settled, setSettled] = useState(0);
  const [pending, setPending] = useState(false);

  const run = useCallback((attestedKey: string) => {
    setPending(true);
    void probeLiteKeyOwners(
      resolveNetwork(envConfig.chain.network),
      attestedKey,
    ).finally(() => {
      setPending(false);
      setSettled((n) => n + 1);
    });
  }, []);

  return { settled, pending, run };
}
