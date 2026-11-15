// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { Outlet } from "@tanstack/react-router";

import { DEBUG_PANEL } from "@humanity/shared/config/debug-panel.ts";
import { DebugPanel } from "@features/debug/DebugPanel.tsx";
import { HumanityActionSessionProvider } from "@shared/navigation/humanity-action-session.tsx";
import { useSweepStrandedPrizes } from "@features/prize/hooks/use-sweep-stranded-prizes.ts";

/** `DebugPanel` is a sibling of the outlet rather than part of any page so it
 *  survives a route change and stays available on the screens that render
 *  instead of the card (pending, account-unavailable), which is exactly when
 *  it is worth reading. Nothing of it is visible until it is summoned —
 *  `Cmd`/`Ctrl`+`D`, or five taps in the top third of the screen — so
 *  `VITE_DEBUG_PANEL` (or a dev build) now only decides whether the hidden
 *  panel is compiled into the bundle at all.
 *
 *  `useSweepStrandedPrizes` runs here because this layout is mounted once for
 *  the whole app and survives every route change: the recovery of a prize left
 *  on product account 0 then happens exactly once per app run, whichever
 *  screen the app opened on and whether or not the user ever visits the prize
 *  route. */
export function RootLayout() {
  useSweepStrandedPrizes();

  return (
    <>
      <HumanityActionSessionProvider>
        <Outlet />
      </HumanityActionSessionProvider>
      {DEBUG_PANEL && <DebugPanel />}
    </>
  );
}
