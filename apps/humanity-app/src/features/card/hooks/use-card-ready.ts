// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient, type QueryCache } from "@tanstack/react-query";

import {
  freshness,
  useForegroundSession,
  type ForegroundSession,
  type Freshness,
} from "@shared/session/foreground-session.ts";

export interface CardReady {
  /** The foreground session the answer is for. */
  sessionId: number;
  /** Whether the card is settled for this session: read from chain, or
   *  failed to, since the session began — or the host answered that it
   *  holds no identity for us, which is the account-unavailable screen. */
  ready: boolean;
}

const CARD_QUERY_KEY = ["chain", "humanity-card"] as const;
const IDENTITY_QUERY_KEY = ["chain", "humanity-user-id"] as const;

/**
 * The card's freshness for `session`, read off the query cache rather than
 * the card hook: the home's data assembly already observes the card, and a
 * second `useHumanityCard` would double its host subscriptions.
 *
 * The card re-keys as the host resolves the accounts under it, so only an
 * active card query — one the screen observes — says where the card stands.
 * With no identity there is no card query to observe: the identity's own
 * answer (`null`, or a refusal) settles the session instead.
 */
function cardFreshness(
  cache: QueryCache,
  session: ForegroundSession,
): Freshness {
  let standing: Freshness = "checking";
  for (const query of cache.findAll({ queryKey: CARD_QUERY_KEY, type: "active" })) {
    const current = freshness(query.state, session);
    if (current === "fresh") return current;
    if (current === "failed") standing = current;
  }
  if (standing !== "checking") return standing;
  const identity = cache.find({ queryKey: IDENTITY_QUERY_KEY, exact: true });
  return identity != null && identity.state.data == null
    ? freshness(identity.state, session)
    : "checking";
}

/** Whether the card has been read in the current foreground session. */
export function useCardReady(): CardReady {
  const session = useForegroundSession();
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback(
    (listener: () => void) => cache.subscribe(listener),
    [cache],
  );
  const read = useCallback(() => cardFreshness(cache, session), [cache, session]);
  const standing = useSyncExternalStore(subscribe, read, read);
  return { sessionId: session.id, ready: standing !== "checking" };
}
