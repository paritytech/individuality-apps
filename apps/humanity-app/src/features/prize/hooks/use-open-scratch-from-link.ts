// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";

import { openScratchPending, settleOpenScratch } from "@shared/navigation/open-scratch-intent.ts";

export interface OpenScratchFromLinkOptions {
  /** Only the home opens it; any other screen leaves the request unread. */
  enabled: boolean;
  /** The card, the ticket and its scratched flag have all been read. */
  ready: boolean;
  /** There is a ticket to scratch now. */
  available: boolean;
  openDaily: () => void;
}

/**
 * Opens the scratch card once when the page was loaded from the scratch link,
 * as soon as the ticket is known. With no ticket to scratch (already
 * scratched, window shut, or none) the request is dropped and the home stays.
 * Returns whether the home should hold off opening anything else: while the
 * request waits, and on the home it opened the scratch from (the navigation
 * lands a render later, and nothing may race it there). The scratch screen is
 * another route, so the home that comes back after it starts fresh.
 */
export function useOpenScratchFromLink({
  enabled,
  ready,
  available,
  openDaily,
}: OpenScratchFromLinkOptions): boolean {
  const [waiting, setWaiting] = useState(openScratchPending);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!waiting || !enabled || !ready) return;
    settleOpenScratch();
    setWaiting(false);
    if (!available) return;
    setOpened(true);
    openDaily();
  }, [waiting, enabled, ready, available, openDaily]);

  return waiting || opened;
}
