// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { pendingRegistrations } from "@individuality/daily-dollar";
import type {
  AirdropStanding,
  Hex32,
} from "@individuality/daily-dollar";
import {
  DEFAULT_REGISTRY_PLAN_CONFIG,
  planRegistrations,
} from "@humanity/shared/airdrops/domain/daily-dollar-registry.ts";
import { readDailyDollarRegistry } from "@humanity/shared/airdrops/storage/daily-dollar-registry-store.ts";

import { loggerFor } from "@humanity/shared/logging/logger.ts";

import {
  AIRDROP_STANDING_QUERY_KEY,
} from "@features/airdrops/hooks/use-airdrop-standing.ts";
import {
  registerForDraws,
  type RegisterDrawsResult,
} from "@humanity/shared/airdrops/chain/register-draws.ts";
import { RegisterDrawsError } from "@humanity/shared/airdrops/chain/register-draws-shared.ts";

export interface AutoRegisterState {
  attempted: number;
  registered: number;
  failed: number;
  lastError: string | null;
  inFlight: boolean;
}

const logger = loggerFor("airdrops", "auto-register");

/** When each event id may next be attempted this session: `Infinity` while
 *  an attempt is in flight, then the registry's retry delay after it settled.
 *  Module-level so every render and every standing refetch shares one
 *  ledger. The registry is the real gate - registered, backing off, busy -
 *  and this is the floor under it, so a registry that cannot be read or
 *  written never turns every standing refetch into a submission. */
const nextAttemptAt = new Map<Hex32, number>();
const RETRY_FLOOR_SECONDS = DEFAULT_REGISTRY_PLAN_CONFIG.registerRetryBackoffSeconds[0] ?? 30;

function attemptable(eventId: Hex32, nowSeconds: number): boolean {
  return (nextAttemptAt.get(eventId) ?? 0) <= nowSeconds;
}

/** Promise chain guarding against overlapping `registerForDraws` calls.
 *  The standing query refetches every 12 s; without serialization each
 *  refetch would race the previous submission's chunks. */
let inFlightChain: Promise<void> = Promise.resolve();

function resetAttemptedEventIdsForTests(): void {
  nextAttemptAt.clear();
  inFlightChain = Promise.resolve();
}

/**
 * Drop the event ids the daily-dollar registry says are already in hand. The
 * registry is the cross-surface ledger: the headless worker writes to it too,
 * so a draw the worker submitted while the app was closed must not be
 * submitted again the moment the app opens.
 *
 * - `submitted` / `registered` / `unknown` hold the draw. `unknown` is
 *   deliberately blocking — the transaction may yet make it into a block, and
 *   a duplicate `register` pays for nothing.
 * - `failed` reopens only once the recorded backoff has elapsed.
 * - `none`, no record, or no account address: open.
 *
 * A read failure leaves every candidate in place: the registry is an
 * optimization over the chain's own `registered` flag, never the authority,
 * and the pending-marker and attempted-id guards still apply.
 */
/**
 * The candidates the registry lets through: the same `planRegistrations` the
 * worker's sweep runs, so the app and the worker hold a busy draw, back off a
 * failed one and retry a stuck one by one rule.
 */
async function withoutRegistryHolds(
  eventIds: Hex32[],
  standing: AirdropStanding,
  nowSeconds: number,
): Promise<Hex32[]> {
  const accountAddress = standing.accountAddress;
  if (accountAddress == null || accountAddress === "") return eventIds;
  const registry = await readDailyDollarRegistry(accountAddress);
  const allowed = new Set(planRegistrations(registry, standing, nowSeconds));
  return eventIds.filter((eventId) => allowed.has(eventId));
}

/**
 * Greedy background registration for manager-scheduled people-airdrops.
 * Watches the supplied standing, picks every draw in `Registering` that this
 * person has not yet registered for (`pendingRegistrations`), and submits
 * them in a single `registerForDraws` call. The register extrinsic handles
 * chunking at the runtime bound; this hook just collects the targets and
 * delegates.
 *
 * Anti-refire guards:
 * - Submission is serialized through a module-level promise chain so two
 *   standing refetches cannot stack submissions.
 * - An event id is retried no sooner than the registry's retry delay after
 *   its last attempt settled (`nextAttemptAt`), and never while one is in
 *   flight. `register` pays on an on-chain failure, so that delay is also
 *   the most a draw that keeps failing on chain costs per attempt.
 * - An event id the daily-dollar registry already holds (submitted,
 *   registered, unknown, or inside a failure backoff) is skipped: that
 *   ledger is shared with the headless worker, so it covers submissions this
 *   tab never made.
 * - An existing alias in a different context short-circuits the whole effect:
 *   every derived slot is wrong and the runtime rejects with `BadOrigin`.
 *   No alias is different: registration first binds the dedicated account.
 *
 * No-op when `enabled` is false.
 */
export function useAutoRegisterDraws(
  standing: AirdropStanding | undefined,
  enabled: boolean,
): AutoRegisterState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AutoRegisterState>({
    attempted: 0,
    registered: 0,
    failed: 0,
    lastError: null,
    inFlight: false,
  });

  const inFlightRef = useRef(false);
  /** Bumped when a registry read finished against a standing that has since
   *  been replaced, so the sweep re-runs against the current one instead of
   *  idling until the next 12 s refetch. */
  const [resweep, setResweep] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const standingValue = standing;
    if (standingValue == null) return;
    if (
      standingValue.contextMatches === false &&
      standingValue.aliasContext != null
    ) {
      setState((current) =>
        current.lastError ===
        "Account alias is not in the airdrops context; every slot is wrong."
          ? current
          : {
              ...current,
              lastError:
                "Account alias is not in the airdrops context; every slot is wrong.",
            },
      );
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const candidates = pendingRegistrations(standingValue, nowSeconds)
      .map((entry) => entry.draw.eventId)
      .filter((eventId) => attemptable(eventId, nowSeconds));
    if (candidates.length === 0) return;
    // The registry read is async, so the guard is taken before it: two effect
    // runs must never both get as far as submitting.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    let cancelled = false;

    void (async () => {
      let targets: Hex32[];
      try {
        targets = await withoutRegistryHolds(candidates, standingValue, nowSeconds);
      } catch (err) {
        logger.warning(
          "daily-dollar registry read failed; submitting unfiltered. error={error}",
          { error: err },
        );
        targets = candidates;
      }
      // Re-check the session ledger: another effect run may have claimed
      // these ids while this one was awaiting the registry.
      targets = targets.filter((eventId) => attemptable(eventId, nowSeconds));
      if (cancelled || targets.length === 0) {
        inFlightRef.current = false;
        if (cancelled) setResweep((count) => count + 1);
        return;
      }
      for (const eventId of targets) {
        nextAttemptAt.set(eventId, Number.POSITIVE_INFINITY);
      }
      setState((current) => ({ ...current, attempted: current.attempted + targets.length, inFlight: true }));

      // Once this attempt settles the registry holds what happened -
      // registered, backing off, or busy - and decides; the floor only stops
      // the very next refetch from going again.
      const release = (): void => {
        const retryAt = Math.floor(Date.now() / 1000) + RETRY_FLOOR_SECONDS;
        for (const eventId of targets) nextAttemptAt.set(eventId, retryAt);
      };
      inFlightChain = inFlightChain.then(async () => {
        let result: RegisterDrawsResult;
        try {
          result = await registerForDraws({ eventIds: targets });
        } catch (err) {
          const causes: string[] = [];
          let current: unknown = err;
          while (current instanceof Error) {
            causes.push(`${current.name}: ${current.message}`);
            current = current.cause;
          }
          if (current != null) causes.push(String(current));
          // Not this device's to register: a standing fact about the host,
          // answered from `registerForDraws`' own memo on every refetch for
          // the next hour, so it is a line in the breadcrumbs, not an issue.
          if (err instanceof RegisterDrawsError && err.code === "not-attested-device") {
            logger.info("auto-register skipped: this device is not the attested one", {
              count: targets.length,
            });
          } else {
            logger.error(
              "auto-register threw before any chunk ran. targets={count} error={error} causes={causes}",
              { count: targets.length, error: err, causes: causes.join(" <- ") },
            );
          }
          setState((current) => ({
            ...current,
            failed: current.failed + targets.length,
            lastError:
              err instanceof Error
                ? err.message
                : "Airdrop registration failed before any chunk ran.",
            inFlight: false,
          }));
          inFlightRef.current = false;
          release();
          return;
        }
        let registered = 0;
        let failed = 0;
        let lastError: string | null = null;
        for (const chunk of result) {
          if (chunk.status === "finalized") registered += chunk.eventIds.length;
          else if (chunk.status === "failed") {
            failed += chunk.eventIds.length;
            if (chunk.error instanceof Error) lastError = chunk.error.message;
          }
          // `unknown` is neither registered nor failed — the marker is still
          // in place, the next refetch will skip it.
        }
        if (registered > 0) {
          void queryClient.invalidateQueries({ queryKey: AIRDROP_STANDING_QUERY_KEY });
        }
        setState((current) => ({
          attempted: current.attempted,
          registered: current.registered + registered,
          failed: current.failed + failed,
          lastError: lastError ?? current.lastError,
          inFlight: false,
        }));
        inFlightRef.current = false;
        release();
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, standing, queryClient, resweep]);

  return state;
}

/** Exposed for tests so each case can reset the cross-instance state. */
export const __resetAutoRegisterForTests = resetAttemptedEventIdsForTests;
