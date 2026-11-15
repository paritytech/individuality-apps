// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { GameRegistration } from "@individuality/shared-records";
import { useQuery } from "@tanstack/react-query";

import { readGameRegistration } from "@features/card/chain/game-registration-read.ts";
import type { QueryTimestamps } from "@shared/session/foreground-session.ts";

/**
 * How often the home looks for a sign-up Jollity has on its way.
 *
 * Host storage has no change notification across products, so a home on
 * screen polls it. It is one local read, and a person who has just tapped
 * Register in Jollity and switched here should see it before they can tap
 * Register again.
 */
const POLL_INTERVAL_MS = 2_000;

/** Jollity's record of its sign-up (`readGameRegistration`) and when it was last read. */
export type GameRegistrationView = { data: GameRegistration | null } & QueryTimestamps;

/**
 * Jollity's record of its sign-up. The read pauses while the page is hidden,
 * so on coming back the cached answer predates the foreground session until
 * the refetch lands; `freshness` tells the two apart.
 */
export function useGameRegistration(enabled: boolean): GameRegistrationView {
  const query = useQuery({
    queryKey: ["host", "game-registration"],
    enabled,
    retry: false,
    staleTime: 0,
    refetchInterval: POLL_INTERVAL_MS,
    queryFn: () => readGameRegistration(),
  });
  return {
    data: query.data ?? null,
    dataUpdatedAt: query.dataUpdatedAt,
    errorUpdatedAt: query.errorUpdatedAt,
  };
}
