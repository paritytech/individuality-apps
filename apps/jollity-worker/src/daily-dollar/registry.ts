// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Jollity's daily-dollar registry: the shared core
 * (`@individuality/daily-dollar`) over Jollity's record, which adds the chat
 * dedupe list and each push's tap target, and the planners only the chat
 * worker runs.
 *
 * The registry is also the restart-safety for every scheduled reminder - each
 * notification id lives here, so whoever sweeps next cancels and reschedules
 * instead of stacking duplicates on the phone.
 *
 * Pure module: types, the record's chat fields, and the reducers/planner
 * that turn a chain standing into actions. No I/O, no React.
 */
import {
  createDailyDollarRegistry,
  type DailyDollarRegistry as CommonDailyDollarRegistry,
  type DrawRecord as CommonDrawRecord,
  type Hex32,
  type LastTick,
  type NotificationKind,
  type RegistryPlanConfig as CommonRegistryPlanConfig,
  type ScheduledNotification as CommonScheduledNotification,
} from "@individuality/daily-dollar";

/**
 * A chat line the worker may post for one draw.
 * - `scratchable`: the draw resolved and the ticket is still unopened.
 * - `result`: what the ticket said once it was opened.
 *
 * One of each per draw at most; {@link DrawRecord.announced} is the dedupe.
 */
export type ChatMessageKind = "scratchable" | "result";

export interface ScheduledNotification extends CommonScheduledNotification {
  /**
   * The tap target the host was given, which it keeps for the push's whole
   * life. Absent on a handle booked before links were recorded: what such a
   * push opens is unknown, so the planner books it again.
   */
  deeplink?: string | null;
}

/**
 * A draw's record as Jollity keeps it. `scratchedAtSeconds` is read by the
 * chat planner: it is the whole difference between "ready to scratch" and
 * "here is what it said".
 */
export interface DrawRecord extends CommonDrawRecord<ScheduledNotification> {
  /** Chat kinds already posted for this draw, so a sweep never repeats one. */
  announced: ChatMessageKind[];
}

export type DailyDollarRegistry = CommonDailyDollarRegistry<DrawRecord>;

/** Tunables for the planner. All durations are seconds unless suffixed. */
export interface RegistryPlanConfig extends CommonRegistryPlanConfig {
  /**
   * Seconds after `drawTimeSeconds` at which the `claim-window` notification
   * fires — the pallet's offchain worker needs time to draw winners after
   * registration closes.
   */
  claimWindowGraceSeconds: number;
  /** Delay before retrying a failed notification push. */
  notificationRetrySeconds: number;
}

/** Copy the planner puts in the notifications it schedules. ASCII only. */
export interface RegistryCopy {
  claimWindow(record: DrawRecord): string;
  won(record: DrawRecord): string;
  missed(record: DrawRecord): string;
}

/** A button the host draws under a chat line; pressing it comes back as an `ActionTriggered` with this id. */
export interface ChatButton {
  actionId: string;
  title: string;
}

/** What a line is about, so the worker can draw it as a card and grey a
 *  ticket's button once it is scratched or its window has shut. */
export type DailyDollarCard =
  | { kind: "ticket" | "miss"; eventId: Hex32; drawTimeSeconds: number }
  | { kind: "won"; eventId: Hex32; drawTimeSeconds: number; prize: string };

/** One chat line: its text, plus the buttons (if any) the host draws under it. */
export interface ChatLine {
  text: string;
  buttons?: readonly ChatButton[];
  card?: DailyDollarCard;
}

/** The one button the worker answers: open the Pocket card. */
export const OPEN_CARD_ACTION_ID = "open-card";

/**
 * Copy the chat planner posts. ASCII only, for the same reason as
 * {@link RegistryCopy}: the host loads the worker bundle as Latin-1.
 */
export interface ChatCopy {
  scratchable(record: DrawRecord): ChatLine;
  /** For both `won` and `claimed`: the ticket was a winner either way. */
  wonResult(record: DrawRecord): ChatLine;
  missResult(record: DrawRecord): ChatLine;
}

/**
 * A side effect the caller must perform, decided purely from the registry.
 * Host-agnostic on purpose: the worker performs all three, the app performs
 * only the notification pair.
 */
export type WorkerAction =
  | { type: "register"; eventIds: Hex32[] }
  | {
      type: "schedule";
      eventId: Hex32;
      kind: NotificationKind;
      /** Unix ms UTC; `null` means push immediately. */
      atMs: number | null;
      text: string;
    }
  | { type: "cancel"; eventId: Hex32; kind: NotificationKind; id: number }
  /**
   * Replace a pending push: book `text` at `atMs` under the current link,
   * then cancel `id`. The old one is only cancelled once its replacement is
   * booked, so a failed push leaves the person with the old one rather than
   * with none.
   */
  | {
      type: "rebook";
      eventId: Hex32;
      kind: NotificationKind;
      id: number;
      atMs: number;
      text: string;
    };

/** One chat line to post, plus the draw it belongs to so the caller can mark
 *  it sent. Separate from {@link WorkerAction}: only the worker has a chat
 *  room, and the app's sweep shares nothing of this half. */
export interface ChatAction extends ChatLine {
  eventId: Hex32;
  kind: ChatMessageKind;
}

/**
 * Defaults the worker and the app share; overridable per deployment.
 * `stuckRegistrationSeconds` outlasts a live attempt's own submit deadline
 * (`worker.ts`: 180 s).
 */
export const DEFAULT_REGISTRY_PLAN_CONFIG: RegistryPlanConfig = {
  claimWindowGraceSeconds: 120,
  registerRetryBackoffSeconds: [30],
  stuckRegistrationSeconds: 240,
  notificationRetrySeconds: 600,
  retentionSeconds: 14 * 86_400,
};

/** Statuses where the draw has not resolved yet, so a reminder is still useful. */
const PRE_RESOLUTION_STATUSES: Record<string, true> = {
  Registering: true,
  AwaitingEntropy: true,
  DrawWinners: true,
};

const CHAT_MESSAGE_KINDS: Record<string, true> = {
  scratchable: true,
  result: true,
};

const core = createDailyDollarRegistry<ScheduledNotification, DrawRecord>({
  fields: {
    notification: ({ deeplink }) =>
      deeplink === null || typeof deeplink === "string" ? { deeplink } : {},
    record: (raw) => {
      // The chat dedupe list is read back now, so an entry this build does not
      // know is not a kind it could ever clear: it is dropped rather than kept.
      // The chat list defaults when absent - a record written before the
      // worker spoke must stay parseable, because rejecting it would forget a
      // registration and pay to make it again.
      const announced: ChatMessageKind[] = [];
      const rawAnnounced = raw["announced"];
      if (Array.isArray(rawAnnounced)) {
        for (const entry of rawAnnounced) {
          if (typeof entry !== "string" || CHAT_MESSAGE_KINDS[entry] !== true) continue;
          const kind = entry as ChatMessageKind;
          if (!announced.includes(kind)) announced.push(kind);
        }
      }
      return { announced };
    },
    placeholder: () => ({ announced: [] }),
  },
  defaultConfig: DEFAULT_REGISTRY_PLAN_CONFIG,
});

export const {
  emptyRegistry,
  sanitizeRegistry,
  reconcileRegistry,
  planRegistrations,
  applyRegistrationSubmitted,
  applyRegistrationResult,
  applyNotificationCancelled,
  applyScratched,
} = core;

const { withRecord } = core;

export interface NotificationPlanOptions {
  /**
   * Whether this caller may push the immediate "you won" notice.
   *
   * `false` for the app: a person looking at the screen is told there and
   * then, and a push would only duplicate what they can already see. The
   * claim-window reminder is left alone either way: it fires for every
   * entrant at the moment the window opens, and only the scratch retires it.
   */
  won: boolean;
  /**
   * The tap target pushes are booked with now. A pending push booked under
   * any other link is booked again, so a link that has moved reaches pushes
   * already sitting in the host and not only the ones booked after it.
   * `null` (the caller could not build one this pass) books nothing again:
   * a push that may open the right place beats one that opens nothing.
   */
  deeplink: string | null;
}

/**
 * Every notification the registry implies: schedule the claim-window
 * reminders, push the win notice, and drop handles for draws that have
 * settled. Decided purely from the record, which is what makes the whole
 * decision layer testable without a host - and what makes it safe for the
 * app and the worker to run the same plan against the same shared record.
 */
export function planNotificationActions(
  registry: DailyDollarRegistry,
  nowSeconds: number,
  config: RegistryPlanConfig,
  copy: RegistryCopy,
  options: NotificationPlanOptions,
): WorkerAction[] {
  const actions: WorkerAction[] = [];
  const nowMs = nowSeconds * 1_000;
  const records = Object.values(registry.draws);

  for (const record of records) {
    if (record.registration.state !== "registered") continue;
    if (record.outcome !== "pending") continue;
    if (PRE_RESOLUTION_STATUSES[record.status] !== true) continue;
    if (record.notifications.some((entry) => entry.kind === "claim-window")) continue;
    if (
      record.notificationRetrySeconds != null &&
      record.notificationRetrySeconds > nowSeconds
    ) {
      continue;
    }
    const atMs = (record.drawTimeSeconds + config.claimWindowGraceSeconds) * 1_000;
    // A reminder for a moment already past would fire instantly and say
    // "check back later"; the `won` path covers that draw instead.
    if (atMs <= nowMs) continue;
    actions.push({
      type: "schedule",
      eventId: record.eventId,
      kind: "claim-window",
      atMs,
      text: copy.claimWindow(record),
    });
  }

  for (const record of records) {
    if (record.outcome !== "won") continue;
    // An opened card needs no invitation: "scratch now" after the scratch is
    // the bug this guard exists for.
    if (record.scratchedAtSeconds != null) continue;
    if (!options.won) continue;
    // A winner with a reminder keeps it, pending or fired: every entrant gets
    // the same push at the same moment, so neither a second push nor an
    // earlier one gives the result away before the scratch. The app does not
    // cancel it either - a winner's reminder vanishing while a loser's stays
    // would tell the two apart, and a cancelled entry reads as "never placed",
    // which sent the worker's `won` push late, after the card was opened. The
    // `won` push only stands in for a reminder that was never placed.
    if (record.notifications.some((entry) => entry.kind === "claim-window")) continue;
    // Same retry gate as the claim-window path: a push that just failed is
    // not retried until its backoff elapses.
    const wantsSchedule =
      !record.notifications.some((entry) => entry.kind === "won") &&
      (record.notificationRetrySeconds == null ||
        record.notificationRetrySeconds <= nowSeconds);
    if (!wantsSchedule) continue;
    actions.push({
      type: "schedule",
      eventId: record.eventId,
      kind: "won",
      atMs: null,
      text: copy.won(record),
    });
  }

  for (const record of records) {
    if (record.registration.state !== "registered") continue;
    if (record.scratchedAtSeconds != null) continue;
    if (
      record.outcome !== "pending" &&
      record.outcome !== "won" &&
      record.outcome !== "miss"
    ) {
      continue;
    }
    const text = copy.missed(record);
    const pending = record.notifications.find((entry) => entry.kind === "missed");
    if (pending != null) {
      // The host fires a scheduled push with the text and link it was given,
      // so one queued under older copy or an older link is swapped while it
      // is still pending. Its words: it reads the same for a winner and a
      // loser, so rewording it gives nothing away, where re-timing a
      // reminder would.
      if (pending.scheduledAtMs <= nowMs) continue;
      const linkCurrent = options.deeplink == null || pending.deeplink === options.deeplink;
      if (pending.text === text && linkCurrent) continue;
    }
    if (
      record.notificationRetrySeconds != null &&
      record.notificationRetrySeconds > nowSeconds
    ) {
      continue;
    }
    const atMs = record.endTimeSeconds * 1_000;
    if (atMs <= nowMs) continue;
    actions.push(
      pending == null
        ? { type: "schedule", eventId: record.eventId, kind: "missed", atMs, text }
        : {
            type: "rebook",
            eventId: record.eventId,
            kind: "missed",
            id: pending.id,
            atMs,
            text,
          },
    );
  }

  for (const record of records) {
    const settled =
      record.outcome === "miss" ||
      record.outcome === "claimed" ||
      record.outcome === "expired";
    // Every push says "come and look", so an opened card retires them all.
    // The "missed" push stays until then, whatever is under it; the others
    // also go once the draw is settled. Claiming only happens with the card
    // open, so it counts as opened.
    const opened = record.scratchedAtSeconds != null || record.outcome === "claimed";
    for (const notification of record.notifications) {
      if (notification.scheduledAtMs <= nowMs) continue;
      if (opened || (notification.kind !== "missed" && settled)) {
        actions.push({
          type: "cancel",
          eventId: record.eventId,
          kind: notification.kind,
          id: notification.id,
        });
        continue;
      }
      // A push that stays but was booked under another link is booked again
      // under the current one, at the same moment with the same words: only
      // where the tap lands changes, so the same holds for every entrant.
      // "missed" is the loop above's, which may also reword it.
      if (notification.kind === "missed") continue;
      if (options.deeplink == null || notification.deeplink === options.deeplink) continue;
      if (
        record.notificationRetrySeconds != null &&
        record.notificationRetrySeconds > nowSeconds
      ) {
        continue;
      }
      actions.push({
        type: "rebook",
        eventId: record.eventId,
        kind: notification.kind,
        id: notification.id,
        atMs: notification.scheduledAtMs,
        text: notification.text,
      });
    }
  }

  return actions;
}

/** Ascending `drawIndex`, compared as the bigint it really is - as decimal
 *  strings, draw 10 would sort before draw 9. */
function byDrawIndex(left: DrawRecord, right: DrawRecord): number {
  const leftIndex = BigInt(left.drawIndex);
  const rightIndex = BigInt(right.drawIndex);
  if (leftIndex === rightIndex) return 0;
  return leftIndex < rightIndex ? -1 : 1;
}

/**
 * Every chat line the registry implies, oldest draw first.
 *
 * At most one line per draw per plan, and the two kinds are mutually
 * exclusive by construction: an unopened ticket is invited to scratch, an
 * opened one is told what it said. A ticket already scratched when the worker
 * first gets to speak therefore skips the invitation entirely - telling
 * someone to scratch a card they have opened reads as a broken robot.
 *
 * The invitation is also withheld once `endTimeSeconds` has passed: the
 * ticket can no longer be claimed, so there is nothing honest left to say.
 * Pure, like the notification planner, and for the same reason - the whole
 * decision layer stays testable without a host.
 */
export function planChatMessages(
  registry: DailyDollarRegistry,
  nowSeconds: number,
  copy: ChatCopy,
): ChatAction[] {
  const actions: ChatAction[] = [];

  for (const record of Object.values(registry.draws).sort(byDrawIndex)) {
    const { eventId, outcome } = record;
    // Only the reveal stamp says the card was opened. `claimed` does not:
    // the app banks a win the moment it is claimable, before the card is
    // touched, so a claimed draw is still a ticket owed its scratch.
    if (record.scratchedAtSeconds != null) {
      if (record.announced.includes("result")) continue;
      if (outcome !== "won" && outcome !== "miss" && outcome !== "claimed") continue;
      actions.push({
        eventId,
        kind: "result",
        ...(outcome === "miss" ? copy.missResult(record) : copy.wonResult(record)),
      });
      continue;
    }
    if (record.announced.includes("scratchable")) continue;
    if (outcome !== "won" && outcome !== "miss" && outcome !== "claimed") continue;
    if (nowSeconds >= record.endTimeSeconds) continue;
    actions.push({ eventId, kind: "scratchable", ...copy.scratchable(record) });
  }

  return actions;
}

/**
 * Remember a host notification id. One entry per kind: rescheduling replaces
 * the handle rather than leaking the old one, which is what keeps a restarted
 * worker from stacking duplicate reminders.
 */
export function applyNotificationScheduled(
  registry: DailyDollarRegistry,
  eventId: Hex32,
  notification: ScheduledNotification,
  nowSeconds: number,
): DailyDollarRegistry {
  const record = registry.draws[eventId];
  if (record == null) return { ...registry };
  return withRecord(registry, {
    ...record,
    notifications: [
      ...record.notifications.filter((entry) => entry.kind !== notification.kind),
      notification,
    ],
    notificationError: null,
    notificationRetrySeconds: null,
    updatedAtSeconds: nowSeconds,
  });
}

/** Record a push/cancel failure and gate the retry. */
export function applyNotificationFailure(
  registry: DailyDollarRegistry,
  eventId: Hex32,
  error: string,
  nowSeconds: number,
  config: RegistryPlanConfig,
): DailyDollarRegistry {
  const record = registry.draws[eventId];
  if (record == null) return { ...registry };
  return withRecord(registry, {
    ...record,
    notificationError: error,
    notificationRetrySeconds: nowSeconds + config.notificationRetrySeconds,
    updatedAtSeconds: nowSeconds,
  });
}

/**
 * Remember that a chat line went out. Idempotent, and the only thing standing
 * between one sweep a minute and a minute-by-minute repetition of the same
 * sentence in the room.
 */
export function applyChatSent(
  registry: DailyDollarRegistry,
  eventId: Hex32,
  kind: ChatMessageKind,
  nowSeconds: number,
): DailyDollarRegistry {
  const record = registry.draws[eventId];
  if (record == null) return { ...registry };
  if (record.announced.includes(kind)) return { ...registry };
  return withRecord(registry, {
    ...record,
    announced: [...record.announced, kind],
    updatedAtSeconds: nowSeconds,
  });
}

/** Stamp the last sweep, so the app can show whether the worker runs. */
export function applyTick(
  registry: DailyDollarRegistry,
  tick: LastTick,
): DailyDollarRegistry {
  return { ...registry, lastTick: tick };
}
