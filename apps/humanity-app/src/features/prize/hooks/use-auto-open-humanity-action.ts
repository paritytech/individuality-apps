// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import type { UsernameClaimTarget } from "@humanity/shared/card/username-claim.ts";
import { nextHumanityAction } from "@features/prize/domain/next-humanity-action.ts";
import { useHumanityActionSession } from "@shared/navigation/humanity-action-session.tsx";
import type { HumanityAction } from "@shared/navigation/humanity-action.ts";

export interface AutoOpenHumanityActionOptions {
  enabled: boolean;
  ready: boolean;
  usernameTarget: UsernameClaimTarget;
}

/** Synchronize the resolved launch action into the URL on the root route. */
export function useAutoOpenHumanityAction({
  enabled,
  ready,
  usernameTarget,
}: AutoOpenHumanityActionOptions): void {
  const navigate = useNavigate();
  const { dismissed, refreshing } = useHumanityActionSession();
  const opening = useRef<HumanityAction | null>(null);
  const next = enabled
    ? nextHumanityAction({
        ready: ready && !refreshing,
        usernameTarget,
        dismissed,
      })
    : null;

  useEffect(() => {
    if (next == null || opening.current === next) return;
    opening.current = next;
    void navigate({ to: "/claim-username" });
    // Navigation is a one-shot URL synchronization; it creates no external
    // subscription or resource that requires cleanup.
  }, [navigate, next]);
}
