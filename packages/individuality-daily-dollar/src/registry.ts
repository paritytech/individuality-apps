// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The daily-dollar registry: one structured record per people-airdrop draw
 * this account has seen, persisted in host key-value storage and shared by
 * the app and the headless worker.
 *
 * It is the single interlock between the two: whoever submits a registration
 * writes it here first, so the other side never re-submits the same draw
 * (`PeopleAirdrops.register` is free on success but pays on failure).
 *
 * This is the part every product keeps the same: the record, the parsing of
 * untrusted storage, the folding of a chain standing into records, the
 * registration gate, and the reducers for registration, scratch and cancel.
 * A product adds its own fields to the record through
 * {@link createDailyDollarRegistry}, and keeps its own planners, defaults and
 * storage. Pure module: no I/O, no React.
 */
import {
  pendingRegistrations,
  type AirdropDrawStatus,
  type AirdropStanding,
  type Hex32,
} from "./draw";

export const DAILY_DOLLAR_REGISTRY_VERSION = 1 as const;

/** Where a registration record came from. */
export type RegistrationSource = "app" | "worker" | "chain";

/**
 * Registration lifecycle for one draw.
 * - `none`: nothing submitted yet.
 * - `submitted`: broadcast, outcome unknown — treated as busy by both sides.
 * - `registered`: finalized on chain, or observed as registered in the standing.
 * - `failed`: a finalized failure; `nextAttemptSeconds` gates the retry.
 * - `unknown`: submission outcome could not be determined; treated as busy.
 */
export type RegistrationState =
  | "none"
  | "submitted"
  | "registered"
  | "failed"
  | "unknown";

/**
 * What the chain has said about this account in the draw.
 * `pending` until the draw resolves; `expired` once the claim window shut.
 */
export type DrawOutcome = "pending" | "won" | "miss" | "claimed" | "expired";

/**
 * - `claim-window`: fires when the draw should have resolved, so the person
 *   opens the app to find out; scheduled at registration time.
 * - `won`: fired immediately for an unclaimed win that never had a reminder.
 * - `missed`: fires when the claim window shuts, for a ticket never scratched;
 *   scheduled alongside the reminder and cancelled once the card is opened.
 */
export type NotificationKind = "claim-window" | "won" | "missed";

export interface ScheduledNotification {
  kind: NotificationKind;
  /** Host-assigned id, the handle for `cancel`. */
  id: number;
  /** Unix ms UTC the host will fire it. */
  scheduledAtMs: number;
  text: string;
}

export interface DrawRegistration {
  state: RegistrationState;
  source: RegistrationSource;
  /** Submissions made by the worker for this draw. */
  attempts: number;
  lastAttemptSeconds: number | null;
  /** Earliest time the worker may try again after a failure. */
  nextAttemptSeconds: number | null;
  txHash: string | null;
  error: string | null;
}

/** One draw's record; `N` is the product's notification handle. */
export interface DrawRecord<N extends ScheduledNotification = ScheduledNotification> {
  eventId: Hex32;
  /** `AirdropDraw.drawIndex` as a decimal string (bigint is not JSON). */
  drawIndex: string;
  status: AirdropDrawStatus;
  drawTimeSeconds: number;
  endTimeSeconds: number;
  /** `AirdropDraw.prizeAmount` in base units as a decimal string. */
  prizeAmount: string;
  registration: DrawRegistration;
  outcome: DrawOutcome;
  notifications: N[];
  /** Last notification push/cancel failure, cleared on success. */
  notificationError: string | null;
  /** Earliest time the worker may retry a failed notification push. */
  notificationRetrySeconds: number | null;
  /**
   * Unix seconds the card was revealed in the app, or `null` when no reveal
   * has been seen on this device. Written by the app; what reads it is the
   * product's own planner.
   */
  scratchedAtSeconds: number | null;
  updatedAtSeconds: number;
}

export type TickResult = "ok" | "error" | "no-account" | "idle";

export interface LastTick {
  atSeconds: number;
  result: TickResult;
  error: string | null;
}

/** The stored registry; `R` is the product's draw record. */
export interface DailyDollarRegistry<R extends DrawRecord = DrawRecord> {
  version: typeof DAILY_DOLLAR_REGISTRY_VERSION;
  /** Dedicated airdrop subaccount the records belong to. */
  accountAddress: string;
  draws: Record<Hex32, R>;
  lastTick: LastTick | null;
}

/**
 * Tunables the registration planner reads. All durations are seconds. Each
 * product owns its defaults, and may add tunables of its own.
 */
export interface RegistryPlanConfig {
  /** Retry delays for failed registrations, indexed by `attempts - 1`, last one repeating; must fit before `drawTimeSeconds`. */
  registerRetryBackoffSeconds: readonly number[];
  /**
   * How long a `submitted` or `unknown` registration counts as busy. No live
   * attempt outlasts its own signing and finality deadlines, so one older
   * than this died with its app or worker, or never landed; while the chain
   * still shows no registration, the draw is planned again rather than left
   * stuck until it closes.
   */
  stuckRegistrationSeconds: number;
  /** Drop records this long after `endTimeSeconds`. */
  retentionSeconds: number;
}

/** Outcome of one `registerForDraws` chunk, as the registry records it. */
export interface RegistrationOutcome {
  status: "finalized" | "failed" | "unknown";
  txHash?: string;
  error?: string;
}

/** What a product's notification handle `N` adds to the common one. */
type NotificationFields<N extends ScheduledNotification> = Omit<N, keyof ScheduledNotification>;

/** What a product's draw record `R` adds to the common one. */
type RecordFields<N extends ScheduledNotification, R extends DrawRecord<N>> = Omit<
  R,
  keyof DrawRecord<N>
>;

/**
 * Rules out every key of `T`. A product's fields are spread over the common
 * ones, so a hook that returned a common key would replace the value the
 * registry validated or set; this makes that a type error instead.
 */
type NoCommonKeys<T> = { [K in keyof T]?: never };

/**
 * The fields a product adds to the common record, read from storage and set
 * on a record the registry has to invent. Each is placed after the common
 * fields it follows in storage, so a product's stored records keep their
 * shape. A field the product does not name is not read back, and a hook may
 * not return a common field.
 */
export interface DrawRecordFields<
  N extends ScheduledNotification,
  R extends DrawRecord<N>,
> {
  /** The product's fields of a stored notification that passed the common checks. */
  notification: (
    raw: Record<string, unknown>,
  ) => NotificationFields<N> & NoCommonKeys<ScheduledNotification>;
  /** The product's fields of a stored record that passed the common checks. */
  record: (raw: Record<string, unknown>) => RecordFields<N, R> & NoCommonKeys<DrawRecord>;
  /** The product's fields of a record the registry invents. */
  placeholder: () => RecordFields<N, R> & NoCommonKeys<DrawRecord>;
}

const NO_RECORD_FIELDS = Object.freeze({});

/** No fields beyond the common record: a product that adds none drops any it finds. */
export const COMMON_RECORD_FIELDS: DrawRecordFields<ScheduledNotification, DrawRecord> = {
  notification: () => NO_RECORD_FIELDS,
  record: () => NO_RECORD_FIELDS,
  placeholder: () => NO_RECORD_FIELDS,
};

export interface DailyDollarRegistryOptions<
  N extends ScheduledNotification,
  R extends DrawRecord<N>,
> {
  fields: DrawRecordFields<N, R>;
  /** The product's defaults, used by `planRegistrations` when it is given none. */
  defaultConfig: RegistryPlanConfig;
}

/** Statuses after the draw, where the claim window is shut or shutting. */
const CLEARING_STATUSES: Record<string, true> = {
  ClearingRegistrations: true,
  ClearingWinners: true,
  Finalizing: true,
};

const DRAW_STATUSES: Record<string, true> = {
  Scheduled: true,
  Registering: true,
  AwaitingEntropy: true,
  DrawWinners: true,
  Claiming: true,
  ClearingRegistrations: true,
  ClearingWinners: true,
  Finalizing: true,
};

const REGISTRATION_STATES: Record<string, true> = {
  none: true,
  submitted: true,
  registered: true,
  failed: true,
  unknown: true,
};

const REGISTRATION_SOURCES: Record<string, true> = {
  app: true,
  worker: true,
  chain: true,
};

const DRAW_OUTCOMES: Record<string, true> = {
  pending: true,
  won: true,
  miss: true,
  claimed: true,
  expired: true,
};

const NOTIFICATION_KINDS: Record<string, true> = {
  "claim-window": true,
  won: true,
  missed: true,
};

const TICK_RESULTS: Record<string, true> = {
  ok: true,
  error: true,
  "no-account": true,
  idle: true,
};

const HEX32_PATTERN = /^0x[0-9a-f]{64}$/i;
const DECIMAL_PATTERN = /^\d+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex32(value: unknown): value is Hex32 {
  return typeof value === "string" && HEX32_PATTERN.test(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function sanitizeRegistration(raw: unknown): DrawRegistration | null {
  if (!isObject(raw)) return null;
  const {
    state,
    source,
    attempts,
    lastAttemptSeconds,
    nextAttemptSeconds,
    txHash,
    error,
  } = raw;
  if (typeof state !== "string" || REGISTRATION_STATES[state] !== true) return null;
  if (typeof source !== "string" || REGISTRATION_SOURCES[source] !== true) return null;
  if (!isFiniteNumber(attempts) || attempts < 0) return null;
  if (!isOptionalNumber(lastAttemptSeconds)) return null;
  if (!isOptionalNumber(nextAttemptSeconds)) return null;
  if (!isOptionalString(txHash)) return null;
  if (!isOptionalString(error)) return null;
  return {
    state: state as RegistrationState,
    source: source as RegistrationSource,
    attempts,
    lastAttemptSeconds,
    nextAttemptSeconds,
    txHash,
    error,
  };
}

function sanitizeTick(raw: unknown): LastTick | null {
  if (!isObject(raw)) return null;
  const { atSeconds, result, error } = raw;
  if (!isFiniteNumber(atSeconds)) return null;
  if (typeof result !== "string" || TICK_RESULTS[result] !== true) return null;
  if (!isOptionalString(error)) return null;
  return { atSeconds, result: result as TickResult, error };
}

/**
 * Outcome implied by one chain participation, or `null` when the chain says
 * nothing that settles it.
 */
function observedOutcome(
  entry: AirdropStanding["participations"][number],
  nowSeconds: number,
): DrawOutcome | null {
  const { draw, registered, winner, claimed } = entry;
  if (claimed === true) return "claimed";
  if (winner === true && draw.status === "Claiming") return "won";
  if (winner === false && registered === true && draw.status === "Claiming") {
    return "miss";
  }
  if (nowSeconds >= draw.endTimeSeconds || CLEARING_STATUSES[draw.status] === true) {
    return "expired";
  }
  return null;
}

/**
 * Fold an observation into the recorded outcome. `claimed` is terminal, and a
 * recorded win never falls back to `pending` or `miss`: the pallet deletes the
 * winner entry on claim, so a later read of the same draw legitimately looks
 * like a loss and would otherwise erase the prize from the record.
 */
function mergeOutcome(current: DrawOutcome, observed: DrawOutcome | null): DrawOutcome {
  if (observed == null) return current;
  if (current === "claimed") return "claimed";
  if (current === "won" && observed !== "claimed" && observed !== "expired") {
    return "won";
  }
  return observed;
}

function sameRecord(left: DrawRecord, right: DrawRecord): boolean {
  return (
    left.drawIndex === right.drawIndex &&
    left.status === right.status &&
    left.drawTimeSeconds === right.drawTimeSeconds &&
    left.endTimeSeconds === right.endTimeSeconds &&
    left.prizeAmount === right.prizeAmount &&
    left.outcome === right.outcome &&
    left.registration.state === right.registration.state &&
    left.registration.source === right.registration.source
  );
}

/**
 * Registration gate: nothing submitted, a failure whose backoff elapsed, or a
 * submission busy for longer than any live attempt can be. Callers only ask
 * for draws the chain still shows this account is not in.
 */
function mayRegister(
  registration: DrawRegistration,
  nowSeconds: number,
  config: RegistryPlanConfig,
): boolean {
  switch (registration.state) {
    case "none":
      return true;
    case "failed":
      return (registration.nextAttemptSeconds ?? 0) <= nowSeconds;
    case "submitted":
    case "unknown":
      // No attempt time means no way to tell it is stuck: it stays busy.
      return (
        registration.lastAttemptSeconds != null &&
        registration.lastAttemptSeconds + config.stuckRegistrationSeconds <= nowSeconds
      );
    case "registered":
      return false;
  }
}

/** Backoff for the failure that just happened; the last delay repeats. */
function retryDelay(attempts: number, config: RegistryPlanConfig): number {
  const delays = config.registerRetryBackoffSeconds;
  if (delays.length === 0) return 0;
  const index = Math.min(Math.max(attempts - 1, 0), delays.length - 1);
  return delays[index] ?? 0;
}

/**
 * The registry over one product's record: `N` is its notification handle,
 * `R` its draw record, and `options.fields` reads and sets what it adds to
 * the common ones. Every function is pure and returns a new registry.
 *
 * The registry builds records itself, so it types them as what it builds:
 * the common fields as declared plus the product's own. For an `R` that keeps
 * the common fields as declared that is `R`; an `R` that narrows one (a
 * literal `status`, say) is not claimed, and the mismatch surfaces where the
 * product reads a record back as its `R`.
 */
export function createDailyDollarRegistry<
  N extends ScheduledNotification,
  R extends DrawRecord<N>,
>({ fields, defaultConfig }: DailyDollarRegistryOptions<N, R>) {
  type ProductNotification = ScheduledNotification & NotificationFields<N>;
  type ProductRecord = DrawRecord<ProductNotification> & RecordFields<N, R>;
  type Registry = DailyDollarRegistry<ProductRecord>;

  /** A registry with no records, used for a fresh account and for bad input. */
  function emptyRegistry(accountAddress: string): Registry {
    return {
      version: DAILY_DOLLAR_REGISTRY_VERSION,
      accountAddress,
      draws: {},
      lastTick: null,
    };
  }

  function sanitizeNotification(raw: unknown): ProductNotification | null {
    if (!isObject(raw)) return null;
    const { kind, id, scheduledAtMs, text } = raw;
    if (typeof kind !== "string" || NOTIFICATION_KINDS[kind] !== true) return null;
    if (!isFiniteNumber(id)) return null;
    if (!isFiniteNumber(scheduledAtMs)) return null;
    if (typeof text !== "string") return null;
    const productFields: NotificationFields<N> = fields.notification(raw);
    // The common fields plus the product's own are the product's handle.
    return {
      kind: kind as NotificationKind,
      id,
      scheduledAtMs,
      text,
      ...productFields,
    };
  }

  function sanitizeRecord(raw: unknown): ProductRecord | null {
    if (!isObject(raw)) return null;
    const {
      eventId,
      drawIndex,
      status,
      drawTimeSeconds,
      endTimeSeconds,
      prizeAmount,
      outcome,
      notifications,
      notificationError,
      notificationRetrySeconds,
      updatedAtSeconds,
    } = raw;
    if (!isHex32(eventId)) return null;
    if (!isDecimal(drawIndex)) return null;
    if (typeof status !== "string" || DRAW_STATUSES[status] !== true) return null;
    if (!isFiniteNumber(drawTimeSeconds)) return null;
    if (!isFiniteNumber(endTimeSeconds)) return null;
    if (!isDecimal(prizeAmount)) return null;
    if (typeof outcome !== "string" || DRAW_OUTCOMES[outcome] !== true) return null;
    if (!Array.isArray(notifications)) return null;
    if (!isOptionalString(notificationError)) return null;
    if (!isOptionalNumber(notificationRetrySeconds)) return null;
    if (!isFiniteNumber(updatedAtSeconds)) return null;
    const registration = sanitizeRegistration(raw["registration"]);
    if (registration == null) return null;
    // One malformed notification only loses that notification's handle: the
    // record itself still carries the registration state both sides gate on.
    const kept: ProductNotification[] = [];
    for (const entry of notifications) {
      const notification = sanitizeNotification(entry);
      if (notification != null) kept.push(notification);
    }
    const productFields: RecordFields<N, R> = fields.record(raw);
    const rawScratched = raw["scratchedAtSeconds"];
    // The common fields plus the product's own are the product's record.
    return {
      eventId,
      drawIndex,
      status: status as AirdropDrawStatus,
      drawTimeSeconds,
      endTimeSeconds,
      prizeAmount,
      registration,
      outcome: outcome as DrawOutcome,
      notifications: kept,
      notificationError,
      notificationRetrySeconds,
      scratchedAtSeconds: isOptionalNumber(rawScratched) ? rawScratched : null,
      ...productFields,
      updatedAtSeconds,
    };
  }

  /**
   * Parse untrusted storage. A registry written by another version or for
   * another account is not repairable, so it is replaced wholesale; a single
   * malformed draw record only costs that record, which the next reconcile
   * rebuilds from chain.
   */
  function sanitizeRegistry(raw: unknown, accountAddress: string): Registry {
    if (!isObject(raw)) return emptyRegistry(accountAddress);
    if (raw["version"] !== DAILY_DOLLAR_REGISTRY_VERSION) {
      return emptyRegistry(accountAddress);
    }
    if (raw["accountAddress"] !== accountAddress) {
      return emptyRegistry(accountAddress);
    }
    const rawDraws = raw["draws"];
    const draws: Record<Hex32, ProductRecord> = {};
    if (isObject(rawDraws)) {
      for (const [key, value] of Object.entries(rawDraws)) {
        const record = sanitizeRecord(value);
        if (record == null || record.eventId !== key) continue;
        draws[record.eventId] = record;
      }
    }
    return {
      version: DAILY_DOLLAR_REGISTRY_VERSION,
      accountAddress,
      draws,
      lastTick: sanitizeTick(raw["lastTick"]),
    };
  }

  /**
   * A record for a draw the chain standing has not shown yet. The worker still
   * has to remember that it submitted for that event id, or a restart would
   * submit again.
   */
  function placeholderRecord(
    eventId: Hex32,
    source: RegistrationSource,
    nowSeconds: number,
  ): ProductRecord {
    const productFields: RecordFields<N, R> = fields.placeholder();
    // The common fields plus the product's own are the product's record.
    return {
      eventId,
      drawIndex: "0",
      status: "Registering",
      drawTimeSeconds: 0,
      endTimeSeconds: 0,
      prizeAmount: "0",
      registration: {
        state: "none",
        source,
        attempts: 0,
        lastAttemptSeconds: null,
        nextAttemptSeconds: null,
        txHash: null,
        error: null,
      },
      outcome: "pending",
      notifications: [],
      notificationError: null,
      notificationRetrySeconds: null,
      scratchedAtSeconds: null,
      ...productFields,
      updatedAtSeconds: nowSeconds,
    };
  }

  /** The registry with `record` stored under its event id. */
  function withRecord(registry: Registry, record: ProductRecord): Registry {
    return {
      ...registry,
      draws: { ...registry.draws, [record.eventId]: record },
    };
  }

  /**
   * Fold a chain standing into the registry: refresh the draw facts, adopt a
   * registration the chain already shows, settle outcomes, and drop records
   * whose retention window has passed.
   *
   * Draws missing from the standing keep their record — a submission in flight
   * for a draw the standing has not caught up with must stay remembered, or
   * both sides would re-submit it.
   */
  function reconcileRegistry(
    registry: Registry,
    standing: AirdropStanding,
    nowSeconds: number,
    config: RegistryPlanConfig,
  ): Registry {
    const draws: Record<Hex32, ProductRecord> = { ...registry.draws };

    for (const entry of standing.participations) {
      const { draw } = entry;
      const current = draws[draw.eventId];
      const base = current ?? placeholderRecord(draw.eventId, "chain", nowSeconds);
      // The chain only says "registered": it cannot say who paid for it. A
      // record that already tracked a submission keeps its provenance, so an
      // app or worker submission that finalizes is not re-attributed to the
      // chain; only a record nobody claimed becomes chain-sourced.
      const keepsSource =
        base.registration.state === "submitted" ||
        base.registration.state === "registered";
      const registration: DrawRegistration =
        entry.registered === true
          ? {
              ...base.registration,
              state: "registered",
              source: keepsSource ? base.registration.source : "chain",
            }
          : base.registration;
      const next: ProductRecord = {
        ...base,
        drawIndex: draw.drawIndex.toString(),
        status: draw.status,
        drawTimeSeconds: draw.drawTimeSeconds,
        endTimeSeconds: draw.endTimeSeconds,
        prizeAmount: draw.prizeAmount.toString(),
        registration,
        outcome: mergeOutcome(base.outcome, observedOutcome(entry, nowSeconds)),
        updatedAtSeconds: nowSeconds,
      };
      draws[draw.eventId] =
        current != null && sameRecord(current, next) ? current : next;
    }

    for (const [eventId, record] of Object.entries(draws) as [Hex32, ProductRecord][]) {
      if (record.endTimeSeconds + config.retentionSeconds < nowSeconds) {
        delete draws[eventId];
      }
    }

    return { ...registry, draws };
  }

  /**
   * The registration gate: every open draw this account is not already on the
   * hook for. Split out from any notification plan because only a caller that
   * can pay for a `register` extrinsic has any business running it.
   */
  function planRegistrations(
    registry: Registry,
    standing: AirdropStanding,
    nowSeconds: number,
    config: RegistryPlanConfig = defaultConfig,
  ): Hex32[] {
    const eventIds: Hex32[] = [];
    for (const entry of pendingRegistrations(standing, nowSeconds)) {
      const record = registry.draws[entry.draw.eventId];
      if (record == null || mayRegister(record.registration, nowSeconds, config)) {
        eventIds.push(entry.draw.eventId);
      }
    }
    return eventIds;
  }

  /**
   * Mark a submission as broadcast. Both sides read `submitted` as busy, which
   * is the interlock that stops the app and the worker paying for the same
   * duplicate `register`.
   */
  function applyRegistrationSubmitted(
    registry: Registry,
    eventIds: readonly Hex32[],
    source: RegistrationSource,
    nowSeconds: number,
  ): Registry {
    if (eventIds.length === 0) return { ...registry };
    const draws: Record<Hex32, ProductRecord> = { ...registry.draws };
    for (const eventId of eventIds) {
      const record = draws[eventId] ?? placeholderRecord(eventId, source, nowSeconds);
      draws[eventId] = {
        ...record,
        registration: {
          ...record.registration,
          state: "submitted",
          source,
          // `attempts` counts worker submissions: it gates the worker's own
          // retries, and an app submission is a person pressing a button.
          attempts:
            source === "worker"
              ? record.registration.attempts + 1
              : record.registration.attempts,
          lastAttemptSeconds: nowSeconds,
          error: null,
        },
        updatedAtSeconds: nowSeconds,
      };
    }
    return { ...registry, draws };
  }

  /** Record the finalized outcome of one `registerForDraws` chunk. */
  function applyRegistrationResult(
    registry: Registry,
    eventIds: readonly Hex32[],
    outcome: RegistrationOutcome,
    source: RegistrationSource,
    nowSeconds: number,
    config: RegistryPlanConfig,
  ): Registry {
    if (eventIds.length === 0) return { ...registry };
    const draws: Record<Hex32, ProductRecord> = { ...registry.draws };
    for (const eventId of eventIds) {
      const record = draws[eventId] ?? placeholderRecord(eventId, source, nowSeconds);
      const previous = record.registration;
      let registration: DrawRegistration;
      if (outcome.status === "finalized") {
        registration = {
          ...previous,
          state: "registered",
          source,
          lastAttemptSeconds: nowSeconds,
          nextAttemptSeconds: null,
          txHash: outcome.txHash ?? previous.txHash,
          error: null,
        };
      } else if (outcome.status === "unknown") {
        // Neither registered nor free to retry: a re-submission could pay for a
        // duplicate. The next standing read settles it.
        registration = {
          ...previous,
          state: "unknown",
          source,
          lastAttemptSeconds: nowSeconds,
          txHash: outcome.txHash ?? previous.txHash,
          error: outcome.error ?? null,
        };
      } else {
        // Counted once per attempt: `applyRegistrationSubmitted` already counted
        // this one when the worker broadcast it.
        const attempts =
          previous.state === "submitted" ? previous.attempts : previous.attempts + 1;
        registration = {
          ...previous,
          state: "failed",
          source,
          attempts,
          lastAttemptSeconds: nowSeconds,
          nextAttemptSeconds: nowSeconds + retryDelay(attempts, config),
          txHash: outcome.txHash ?? previous.txHash,
          error: outcome.error ?? "registration failed",
        };
      }
      draws[eventId] = { ...record, registration, updatedAtSeconds: nowSeconds };
    }
    return { ...registry, draws };
  }

  /** Forget a notification handle the host no longer holds. */
  function applyNotificationCancelled(
    registry: Registry,
    eventId: Hex32,
    kind: NotificationKind,
    nowSeconds: number,
  ): Registry {
    const record = registry.draws[eventId];
    if (record == null) return { ...registry };
    const notifications = record.notifications.filter((entry) => entry.kind !== kind);
    if (notifications.length === record.notifications.length) return { ...registry };
    return withRecord(registry, {
      ...record,
      notifications,
      updatedAtSeconds: nowSeconds,
    });
  }

  /**
   * Stamp the moment the card was revealed. Written by the app - nothing else
   * can see a finger on a screen - and read by the product's planner, which
   * treats an opened ticket differently from one still waiting.
   *
   * Never re-stamped: the first reveal is the one that counts, and a remount of
   * the same card must not move it. A record the registry has never heard of is
   * left alone rather than invented.
   */
  function applyScratched(
    registry: Registry,
    eventId: Hex32,
    nowSeconds: number,
  ): Registry {
    const record = registry.draws[eventId];
    if (record == null) return { ...registry };
    if (record.scratchedAtSeconds != null) return { ...registry };
    return withRecord(registry, {
      ...record,
      scratchedAtSeconds: nowSeconds,
      updatedAtSeconds: nowSeconds,
    });
  }

  return {
    emptyRegistry,
    sanitizeRegistry,
    reconcileRegistry,
    planRegistrations,
    applyRegistrationSubmitted,
    applyRegistrationResult,
    applyNotificationCancelled,
    applyScratched,
    withRecord,
  };
}
