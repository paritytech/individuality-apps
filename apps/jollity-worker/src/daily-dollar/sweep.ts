// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One sweep over an account's Daily Dollar standing.
 *
 * The decisions are not made here at all - `reconcileRegistry` folds the
 * chain standing into the shared record and the planner decides what must
 * happen; this module only performs those effects and folds each outcome back
 * in, which is what keeps retry, backoff and de-duplication unit-testable in
 * the pure domain. Everything host-shaped arrives as {@link SweepDeps}; the
 * Jollity chat passes them in ./worker.
 *
 * Three properties are load-bearing:
 *
 *  - **Reducers replay onto the stored record.** A sweep reads the registry
 *    once and keeps that copy for its own in-flight decisions, but never
 *    writes it back: the app and `registerForDraws` mutate the same stored
 *    record through `updateDailyDollarRegistry` while a sweep runs, so a
 *    blind write would erase their markers. Every reducer the pass applies
 *    locally is queued and replayed onto the store's current value instead,
 *    with `applyRegistrationResult` deliberately left out -
 *    `registerForDraws` records submitted+result itself, and replaying it
 *    would double-count `attempts`.
 *  - **Notifications are resolved lazily.** On a phone, getting the handle
 *    means asking the person for the notification permission. A sweep with
 *    nothing to schedule must not raise that prompt, so the resolver is
 *    called from the schedule/cancel executors and at most once per pass.
 *  - **Nothing claims.** Claiming is the in-app scratch card. A sweep only
 *    registers and keeps the reminders honest.
 */
import type {
  AirdropStanding,
  Hex32,
  RegistrationOutcome,
  TickResult,
} from "@individuality/daily-dollar";
import {
  applyNotificationCancelled,
  applyNotificationFailure,
  applyNotificationScheduled,
  applyRegistrationResult,
  applyTick,
  planNotificationActions,
  planRegistrations,
  reconcileRegistry,
  type DailyDollarRegistry,
  type RegistryCopy,
  type RegistryPlanConfig,
  type ScheduledNotification,
  type WorkerAction,
} from "./registry";
import { loggerFor } from "./log";

/** What one `PeopleAirdrops.register` call came to. */
interface RegisterDrawChunkResult {
  eventIds: Hex32[];
  status: "finalized" | "unknown" | "failed";
  txHash?: string;
  error?: unknown;
}

export type RegisterDrawsResult = RegisterDrawChunkResult[];

const logger = loggerFor("airdrops", "daily-dollar-sweep");

/** The host's scheduled-notification surface, in the sweep's own terms:
 *  `scheduledAtMs` is `null` for "fire now" rather than an absent key. */
export interface SweepNotifications {
  push(input: {
    text: string;
    deeplink?: string;
    scheduledAtMs: number | null;
  }): Promise<number>;
  cancel(id: number): Promise<void>;
}

/**
 * One registry mutation, deferred. A sweep collects these so the store's
 * current value - not the copy the sweep read - is what they land on.
 */
type RegistryReducer = (
  registry: DailyDollarRegistry,
) => DailyDollarRegistry;

export interface SweepDeps {
  /** Wall clock in unix seconds - injected so tests can advance it. */
  now(): number;
  /**
   * `null` when this caller never registers. The app passes `null`: it has
   * its own auto-register loop with its own UI state, and two writers racing
   * for the same draw is what the shared record exists to prevent.
   */
  registerForDraws: ((eventIds: Hex32[]) => Promise<RegisterDrawsResult>) | null;
  /**
   * Resolved only when there is something to schedule or cancel, so a pass
   * with no notification work never asks for the permission. Memoized by the
   * resolver itself across passes, and by the sweep within one.
   */
  notifications: () => Promise<SweepNotifications | null>;
  readRegistry(accountAddress: string): Promise<DailyDollarRegistry>;
  /** Read-modify-write the stored record under the store's own per-account
   *  serialization, so a concurrent write is composed, not clobbered. */
  updateRegistry(
    accountAddress: string,
    update: RegistryReducer,
  ): Promise<DailyDollarRegistry>;
  /** Product URL a notification tap opens; `null` to push without a link. */
  deeplink: string | null;
  config: RegistryPlanConfig;
  copy: RegistryCopy;
  /**
   * Whether this caller may push the immediate win notice. `false` in the
   * app, which tells the person on screen instead.
   */
  won: boolean;
}

export interface SweepOutcome {
  result: TickResult;
  /** What the planner asked for, for logging and for the caller's own state. */
  actions: WorkerAction[];
}

/** Failures reach the registry as text, so they must never carry an object
 *  the JSON round-trip would hollow out. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Per-pass log line: counts only. The registry itself can hold a fortnight
 *  of draws, and logging it would drown the host console every minute. */
function summarizeActions(actions: readonly WorkerAction[]): string {
  const counts = { register: 0, schedule: 0, cancel: 0, rebook: 0 };
  for (const action of actions) counts[action.type] += 1;
  return (
    `register=${counts.register} schedule=${counts.schedule} ` +
    `cancel=${counts.cancel} rebook=${counts.rebook}`
  );
}

/**
 * One pass over `standing`: read the registry once for this pass's own
 * decisions, run the planned effects, then replay the reducers those effects
 * produced onto the store's current value rather than writing the copy read
 * at the start.
 *
 * Never throws. A failure is reported as `error` and stamped on `lastTick`,
 * so the app can show that a sweep ran and what broke.
 */
export async function runDailyDollarSweep(
  deps: SweepDeps,
  accountAddress: string,
  standing: AirdropStanding,
): Promise<SweepOutcome> {
  const nowSeconds = deps.now();
  const pending: RegistryReducer[] = [];

  // At most one resolution per pass, shared by every schedule and cancel.
  let handle: Promise<SweepNotifications | null> | null = null;
  const notifications = (): Promise<SweepNotifications | null> =>
    (handle ??= deps.notifications());

  /** Replay this pass's reducers onto whatever the store holds right now. */
  async function commit(): Promise<void> {
    await deps.updateRegistry(accountAddress, (current) =>
      pending.reduce((acc, fn) => fn(acc), current),
    );
  }

  async function runRegister(
    registry: DailyDollarRegistry,
    eventIds: readonly Hex32[],
    register: (ids: Hex32[]) => Promise<RegisterDrawsResult>,
  ): Promise<DailyDollarRegistry> {
    if (eventIds.length === 0) return registry;
    logger.info("registering for {count} draw(s)", { count: eventIds.length });
    const results = await register([...eventIds]);
    // Applied to the local copy only, never queued for replay:
    // `registerForDraws` already recorded submitted+result in the store
    // itself, and replaying it here would count the same attempt twice.
    let next = registry;
    for (const chunk of results) {
      const outcome: RegistrationOutcome = {
        status: chunk.status,
        ...(chunk.txHash == null ? {} : { txHash: chunk.txHash }),
        ...(chunk.error == null ? {} : { error: describe(chunk.error) }),
      };
      next = applyRegistrationResult(
        next,
        chunk.eventIds,
        outcome,
        "worker",
        nowSeconds,
        deps.config,
      );
    }
    return next;
  }

  async function runSchedule(
    registry: DailyDollarRegistry,
    action: Extract<WorkerAction, { type: "schedule" }>,
  ): Promise<DailyDollarRegistry> {
    const host = await notifications();
    if (host == null) {
      logger.debug("no notification manager; skipping {kind} for {eventId}", {
        kind: action.kind,
        eventId: action.eventId,
      });
      return registry;
    }
    try {
      const id = await host.push({
        text: action.text,
        ...(deps.deeplink == null ? {} : { deeplink: deps.deeplink }),
        scheduledAtMs: action.atMs,
      });
      const notification: ScheduledNotification = {
        kind: action.kind,
        id,
        scheduledAtMs: action.atMs ?? nowSeconds * 1000,
        text: action.text,
        deeplink: deps.deeplink,
      };
      pending.push((current) =>
        applyNotificationScheduled(
          current,
          action.eventId,
          notification,
          nowSeconds,
        ),
      );
      return applyNotificationScheduled(
        registry,
        action.eventId,
        notification,
        nowSeconds,
      );
    } catch (error) {
      // A push can fail because the host hit its pending-notification cap
      // (`ScheduleLimitReached`), which clears on its own as earlier ones
      // fire: recorded, retried later, never fatal to the pass.
      const message = describe(error);
      logger.warning("notification push failed for {eventId}: {error}", {
        eventId: action.eventId,
        error: message,
      });
      pending.push((current) =>
        applyNotificationFailure(
          current,
          action.eventId,
          message,
          nowSeconds,
          deps.config,
        ),
      );
      return applyNotificationFailure(
        registry,
        action.eventId,
        message,
        nowSeconds,
        deps.config,
      );
    }
  }

  async function runCancel(
    registry: DailyDollarRegistry,
    action: Extract<WorkerAction, { type: "cancel" }>,
  ): Promise<DailyDollarRegistry> {
    const host = await notifications();
    if (host != null) {
      try {
        await host.cancel(action.id);
      } catch (error) {
        // Cancelling an id the host has already fired or forgotten is a
        // no-op on its side; the record is dropped either way, otherwise the
        // planner would keep re-issuing the same cancel every minute.
        logger.debug("notification cancel failed for {id}: {error}", {
          id: action.id,
          error: describe(error),
        });
      }
    }
    pending.push((current) =>
      applyNotificationCancelled(current, action.eventId, action.kind, nowSeconds),
    );
    return applyNotificationCancelled(
      registry,
      action.eventId,
      action.kind,
      nowSeconds,
    );
  }

  /**
   * Book the replacement first and cancel the old push only once it is in:
   * a failed push leaves the old one where it was, to be tried again after
   * the backoff, rather than leaving nothing.
   */
  async function runRebook(
    registry: DailyDollarRegistry,
    action: Extract<WorkerAction, { type: "rebook" }>,
  ): Promise<DailyDollarRegistry> {
    const next = await runSchedule(registry, {
      type: "schedule",
      eventId: action.eventId,
      kind: action.kind,
      atMs: action.atMs,
      text: action.text,
    });
    const booked = next.draws[action.eventId]?.notifications.some(
      (entry) => entry.kind === action.kind && entry.id !== action.id,
    );
    if (booked !== true) return next;
    const host = await notifications();
    try {
      await host?.cancel(action.id);
    } catch (error) {
      // Already fired or forgotten on the host's side; the handle was
      // replaced either way.
      logger.debug("notification cancel failed for {id}: {error}", {
        id: action.id,
        error: describe(error),
      });
    }
    logger.info("rebooked {kind} for {eventId} under the current link", {
      kind: action.kind,
      eventId: action.eventId,
    });
    return next;
  }

  function execute(
    registry: DailyDollarRegistry,
    action: WorkerAction,
  ): Promise<DailyDollarRegistry> {
    switch (action.type) {
      case "register": {
        const register = deps.registerForDraws;
        // Unreachable: the plan only carries a register action for a caller
        // that has the handle. Narrowed rather than asserted, because the
        // alternative is a non-null assertion on a dep the app passes null.
        if (register == null) return Promise.resolve(registry);
        return runRegister(registry, action.eventIds, register);
      }
      case "schedule":
        return runSchedule(registry, action);
      case "cancel":
        return runCancel(registry, action);
      case "rebook":
        return runRebook(registry, action);
    }
  }

  let registry: DailyDollarRegistry;
  try {
    registry = await deps.readRegistry(accountAddress);
  } catch (error) {
    // Nothing to stamp a lastTick onto: a failed read leaves the pass with no
    // idea what the stored record holds, so it queues nothing.
    logger.error("registry read failed: {error}", { error: describe(error) });
    return { result: "error", actions: [] };
  }

  pending.push((current) =>
    reconcileRegistry(current, standing, nowSeconds, deps.config),
  );
  registry = reconcileRegistry(registry, standing, nowSeconds, deps.config);

  const actions: WorkerAction[] = [];
  if (deps.registerForDraws != null) {
    const eventIds = planRegistrations(registry, standing, nowSeconds, deps.config);
    if (eventIds.length > 0) actions.push({ type: "register", eventIds });
  }
  actions.push(
    ...planNotificationActions(registry, nowSeconds, deps.config, deps.copy, {
      won: deps.won,
      deeplink: deps.deeplink,
    }),
  );

  try {
    for (const action of actions) {
      // Sequential: the planner's order is load-bearing (a `won` push is
      // preceded by the cancel of the claim-window reminder it replaces),
      // and each step folds into the registry the next one reads.
      registry = await execute(registry, action);
    }
    logger.info("sweep ok: {summary}", { summary: summarizeActions(actions) });
    pending.push((current) =>
      applyTick(current, { atSeconds: nowSeconds, result: "ok", error: null }),
    );
    await commit();
    return { result: "ok", actions };
  } catch (error) {
    // Whatever did land stays landed: `pending` carries every reducer from an
    // action that completed before the failure, and the tick record says what
    // broke so the app can surface it.
    const message = describe(error);
    logger.error("sweep failed: {error}", { error: message });
    pending.push((current) =>
      applyTick(current, {
        atSeconds: nowSeconds,
        result: "error",
        error: message,
      }),
    );
    try {
      await commit();
    } catch (writeError) {
      // The pass already failed for its own reason; a failing update must not
      // replace that with a storage error.
      logger.error("registry update failed after a failed sweep: {error}", {
        error: describe(writeError),
      });
    }
    return { result: "error", actions };
  }
}
