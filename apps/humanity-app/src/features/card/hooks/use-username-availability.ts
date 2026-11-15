// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Whether a full name is free for this lite identity to claim, read live from
 * the People Chain as the person types. A name is taken when
 * `Resources.UsernameOwnerOf` has an owner for it, or when its reservation
 * queue is fronted by another account. A host reserves the bare name for a
 * lite person at registration, and the runtime lets the identity at the
 * front of that queue claim it via `register_person(Reservation)`; an own
 * entry further back fails with `NotReservationHolder`. These are the same
 * reads the claim's preflight makes, so what the form says and what the
 * chain accepts agree. The read is debounced so a keystroke never fires a
 * query, and a read the person has typed past is abandoned.
 *
 * The runtime never drops an expired entry by itself, so an own reservation
 * can sit behind entries that lapsed long ago. When every entry it waits
 * behind could be removed (`domain/expired-reservations.ts`), the hook removes
 * them in the background (`chain/clear-expired-reservations.ts`), once per
 * name and lite identity, and reads the name again: it shows `checking`
 * meanwhile, and whatever the queue then says.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Binary } from "polkadot-api";

import { clearExpiredReservations } from "@features/card/chain/clear-expired-reservations.ts";
import { expiredEntriesAhead } from "@features/card/domain/expired-reservations.ts";
import { runBoundedChainRead } from "@humanity/shared/chain/bounded-read.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";

/** Full person labels are lowercase ASCII letters only, 6–32 of them —
 *  the same bound the Individuality runtime enforces. */
export const FULL_USERNAME = /^[a-z]{6,32}$/;

export type UsernameAvailability =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "checking"; name: string }
  | { status: "available"; name: string }
  | { status: "taken"; name: string }
  | { status: "error"; name: string; retry: () => void };

const DEBOUNCE_MS = 400;

/** The query key for one name's answer, so a rejected claim can drop it. */
export const usernameAvailabilityKey = (name?: string) =>
  name == null ? ["chain", "username-availability"] : ["chain", "username-availability", name];

interface AvailabilityRead {
  readonly taken: boolean;
  /** Taken only by entries ahead of this lite identity's own that have all expired. */
  readonly clearable: boolean;
}

async function readAvailability(
  name: string,
  liteAddress: string,
  signal: AbortSignal,
): Promise<AvailabilityRead> {
  const { api } = await getPeopleClient();
  signal.throwIfAborted();
  const key = Binary.fromText(name);
  const owner = await api.query.Resources.UsernameOwnerOf.getValue(key, { signal });
  if (owner != null) return { taken: true, clearable: false };
  const queue = await api.query.Resources.UsernameReservationQueue.getValue(key, { signal });
  const holder = queue?.[0]?.account;
  if (holder == null || holder === liteAddress) return { taken: false, clearable: false };
  const position = queue!.findIndex((entry) => entry.account === liteAddress);
  if (position === -1) return { taken: true, clearable: false };
  const [duration, now] = await Promise.all([
    api.query.Resources.UsernameReservationDuration.getValue({ signal }),
    api.query.Timestamp.Now.getValue({ signal }),
  ]);
  const expired = expiredEntriesAhead(queue!, liteAddress, now / 1000n, duration);
  return { taken: true, clearable: expired.length === position };
}

/** Name and lite identity pairs a cleanup was started for, this session. */
const cleanupsStarted = new Set<string>();

export function resetReservationCleanupsForTests(): void {
  cleanupsStarted.clear();
}

/**
 * Start the cleanup of `name`'s expired entries ahead of `liteAddress` when
 * `clearable`, once per pair, and read the name again when it settles.
 * True while it runs.
 */
function useExpiredReservationCleanup(name: string, liteAddress: string, clearable: boolean): boolean {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState<string | null>(null);
  const pair = `${name}\u0000${liteAddress}`;
  useEffect(() => {
    if (!clearable || cleanupsStarted.has(pair)) return;
    cleanupsStarted.add(pair);
    setRunning(pair);
    void clearExpiredReservations(name, liteAddress).finally(() => {
      setRunning((current) => (current === pair ? null : current));
      void queryClient.invalidateQueries({ queryKey: usernameAvailabilityKey(name) });
    });
  }, [clearable, pair, name, liteAddress, queryClient]);
  return running === pair;
}

/** Debounce a value: the last one typed, once typing pauses. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** `liteAddress` is the SS58 lite account claiming the name; its own
 *  front-of-queue reservation counts as available. */
export function useUsernameAvailability(
  name: string,
  enabled = true,
  liteAddress: string,
): UsernameAvailability {
  const settled = useSettled(name, DEBOUNCE_MS);
  const valid = FULL_USERNAME.test(name);
  const query = useQuery({
    queryKey: [...usernameAvailabilityKey(settled), liteAddress],
    enabled: enabled && FULL_USERNAME.test(settled),
    retry: false,
    staleTime: 15_000,
    queryFn: ({ signal }) =>
      runBoundedChainRead(signal, (childSignal) =>
        readAvailability(settled, liteAddress, childSignal),
      ),
  });
  const clearing = useExpiredReservationCleanup(
    settled,
    liteAddress,
    enabled && query.data?.clearable === true,
  );

  if (name === "") return { status: "idle" };
  if (!valid) return { status: "invalid" };
  if (!enabled) return { status: "idle" };
  if (settled !== name || query.isPending || clearing) return { status: "checking", name };
  if (query.error != null) {
    return { status: "error", name, retry: () => void query.refetch() };
  }
  return query.data?.taken === true ? { status: "taken", name } : { status: "available", name };
}
