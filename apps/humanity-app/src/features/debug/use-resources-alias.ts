// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";

import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { probeResourcesAlias } from "@humanity/shared/chain/resources-alias.ts";
import { envConfig } from "@humanity/shared/config/env.ts";

/**
 * Probe the Resources alias once while the panel is open.
 *
 * Two host round trips, so it is not run on page load: nothing outside the panel
 * reads it, and the answer only changes when the alias is bound. The probe
 * writes to the module-level diagnostics that `withChainDiagnostics` reads, so
 * the rendered panel and the copied JSON see the same answer — but a module
 * write cannot repaint, hence the settle counter this returns.
 *
 * @returns a value that changes once the probe settles, to depend on for a
 *   re-render. The diagnostics themselves come from `withChainDiagnostics`.
 */
export function useResourcesAliasProbe(open: boolean): number {
  const [settled, setSettled] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void probeResourcesAlias(resolveNetwork(envConfig.chain.network)).finally(
      () => {
        // A closed panel leaves the recorded answer in place for the next open.
        if (live) setSettled((n) => n + 1);
      },
    );
    return () => {
      live = false;
    };
  }, [open]);

  return settled;
}
