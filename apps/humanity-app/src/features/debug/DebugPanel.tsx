// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * State inspector, mounted by `RootLayout`.
 *
 * It has no visible affordance at all: nothing on screen hints at it, and it
 * is summoned by gesture only — `Cmd`/`Ctrl`+`D`, or five taps in the top
 * third of the screen (see `useDebugSummon`). That is what lets it ship in a
 * production build: an operator who knows the gesture can read the app's
 * state anywhere, and a user who does not never meets it.
 *
 * `VITE_DEBUG_PANEL` still decides whether it is compiled in at all (see
 * `DEBUG_PANEL`); the flag folds at build time, so an off build drops this
 * component and its stylesheet entirely.
 *
 * It issues no chain READ of its own — every value shown is what the page
 * itself saw. `DebugMutations` is the one deliberate exception in the other
 * direction: it writes, on operator command only, and never on render.
 */
import { Link, useRouterState } from "@tanstack/react-router";

import { DEBUG_PANEL } from "@humanity/shared/config/debug-panel.ts";

import { DebugPanelBody } from "./DebugPanelBody.tsx";
import { useDebugStore } from "./debug-store.ts";
import { useCoinageBalanceWatch } from "./use-coinage-balance.ts";
import { latestPrizeAssetId, usePayoutBalanceWatch } from "./use-payout-balance.ts";
import { useResourcesAliasProbe } from "./use-resources-alias.ts";
import { useDebugSummon } from "./use-debug-summon.ts";
import { usePocketFaceMirror } from "./use-pocket-face-mirror.ts";

// A static import would keep this in the CSS bundle even after the component
// is tree-shaken (Vite collects CSS at transform time), so it hangs off the
// same build-time flag.
if (DEBUG_PANEL) {
  void import("./styles/debug.css");
}

export function DebugPanel() {
  const open = useDebugStore((state) => state.open);
  const toggle = useDebugStore((state) => state.toggle);
  const close = useDebugStore((state) => state.close);
  const standing = useDebugStore((state) => state.input?.airdrops);
  const simulating = useDebugStore(
    (state) => state.scenario != null || state.prize.outcome != null,
  );
  const onDebugPage = useRouterState({
    select: (state) => state.location.pathname === "/debug",
  });
  useDebugSummon({ toggle, close });
  usePocketFaceMirror();
  // Repaints once the host answers; the diagnostics themselves arrive through
  // `withChainDiagnostics`, so the rendered panel and the copied JSON agree.
  useResourcesAliasProbe(open && !onDebugPage);
  useCoinageBalanceWatch(open && !onDebugPage);
  usePayoutBalanceWatch(open && !onDebugPage, latestPrizeAssetId(standing));

  if (!DEBUG_PANEL || onDebugPage) return null;

  // A persisted scenario or prize override keeps shaping the app after the
  // panel is dismissed. With no toggle left to carry the old amber dot, this
  // pill is the one thing that says "what you see is simulated" — and the
  // way back in without knowing the gesture.
  if (!open) {
    return simulating ? (
      <button
        type="button"
        className="debug-sim-badge"
        onClick={toggle}
        aria-controls="debug-panel"
        title="A debug scenario is active"
      >
        SIM
      </button>
    ) : null;
  }

  return (
    <aside id="debug-panel" className="debug-panel" aria-label="Debug state">
      <DebugPanelBody
        actions={
          <>
            <Link to="/debug" className="debug-chip debug-expand">
              Open as page ↗
            </Link>
            <button type="button" className="debug-chip" onClick={close}>
              Hide
            </button>
          </>
        }
      />
    </aside>
  );
}
