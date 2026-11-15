// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import type { HumanityAction } from "./humanity-action.ts";

interface HumanityActionSession {
  dismissed: readonly HumanityAction[];
  refreshing: boolean;
  dismiss: (action: HumanityAction) => void;
}

const ActionSessionContext = createContext<HumanityActionSession | null>(null);

/** The chain reads a launch action is decided on: the card (with the best-block
 *  overlay of a name claim it carries) and, on the claim screen, the
 *  full-personhood check. A game that just ended moves exactly these. */
const LAUNCH_ACTION_QUERIES: Record<string, true> = {
  "humanity-card": true,
  "username-upgrade-best": true,
  "full-personhood": true,
};

function isLaunchActionQuery({ queryKey }: Query): boolean {
  return (
    queryKey[0] === "chain" &&
    typeof queryKey[1] === "string" &&
    LAUNCH_ACTION_QUERIES[queryKey[1]] === true
  );
}

/** Holds route dismissals across child-route changes, resetting them whenever
 * the host brings Humanity back to the foreground. */
export function HumanityActionSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<readonly HumanityAction[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const refreshGeneration = useRef(0);

  useEffect(() => {
    const beginForegroundSession = (event: Event) => {
      if (document.visibilityState === "hidden") return;
      setDismissed([]);
      setRefreshing(true);
      const generation = refreshGeneration.current + 1;
      refreshGeneration.current = generation;
      // The first load's own `pageshow` lands while that load's mount reads
      // are on the wire: they already read a block from after the return, so
      // join them rather than throw them away. Any other foreground event
      // restarts a read in flight, which may have pinned a block from before
      // the person left.
      const options = {
        cancelRefetch: !(
          event.type === "pageshow" &&
          (event as PageTransitionEvent).persisted === false
        ),
      };
      // The card first and on its own: coming back from a game, the score it
      // reads is what puts the name claim on offer, and every other chain read
      // started beside it shares the one People client and slows it down.
      // Only the card decides the launch action, so the session is settled
      // as soon as it lands; the rest of the screen catches up after.
      void queryClient
        .refetchQueries(
          { type: "active", predicate: isLaunchActionQuery },
          options,
        )
        .finally(() => {
          if (refreshGeneration.current !== generation) return;
          setRefreshing(false);
          void queryClient.refetchQueries(
            {
              type: "active",
              predicate: (query) =>
                query.queryKey[0] === "chain" && !isLaunchActionQuery(query),
            },
            options,
          );
        });
    };

    document.addEventListener("visibilitychange", beginForegroundSession);
    window.addEventListener("focus", beginForegroundSession);
    window.addEventListener("pageshow", beginForegroundSession);
    return () => {
      refreshGeneration.current += 1;
      document.removeEventListener("visibilitychange", beginForegroundSession);
      window.removeEventListener("focus", beginForegroundSession);
      window.removeEventListener("pageshow", beginForegroundSession);
    };
  }, [queryClient]);

  const dismiss = useCallback((action: HumanityAction) => {
    setDismissed((current) =>
      current.includes(action) ? current : [...current, action],
    );
  }, []);
  const value = useMemo(
    () => ({ dismissed, refreshing, dismiss }),
    [dismissed, refreshing, dismiss],
  );

  return <ActionSessionContext value={value}>{children}</ActionSessionContext>;
}

export function useHumanityActionSession(): HumanityActionSession {
  const session = useContext(ActionSessionContext);
  if (session == null) {
    throw new Error("Humanity action session is missing");
  }
  return session;
}
