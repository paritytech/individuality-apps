// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** PrizePage URL routing and navigation. */
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";

import type { PrizeDemoState } from "@features/prize/domain/prize-demo.ts";

declare module "@tanstack/history" {
  interface HistoryState {
    /** The scratch screen was opened from the home, which is the entry
     *  behind it: closing it goes back rather than adding another home. */
    fromHome?: boolean;
  }
}

export type PrizeScreen = "home" | "daily";

export interface PrizePageRouting {
  screen: PrizeScreen;
  openDaily: () => void;
  closeDaily: () => void;
}

export function usePrizePageRouting(
  demoState: PrizeDemoState,
  screen: PrizeScreen,
): PrizePageRouting {
  const navigate = useNavigate();
  const router = useRouter();
  const fromHome = useLocation({ select: (location) => location.state.fromHome === true });
  const demo = demoState === "live" ? undefined : demoState;
  const openDaily = () => {
    void navigate({ to: "/scratch", search: { demo }, state: { fromHome: true } });
  };
  // Back from a home tap so the system back button cannot reopen the card.
  const closeDaily = () => {
    if (fromHome) {
      router.history.back();
      return;
    }
    void navigate({ to: "/", search: { demo }, replace: true });
  };

  return { screen, openDaily, closeDaily };
}
