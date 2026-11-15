// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  DAILY_DOLLAR_REGISTRY_VERSION,
  type AirdropDraw,
  type AirdropDrawStatus,
  type AirdropParticipation,
  type AirdropStanding,
  type Hex32,
} from "@individuality/daily-dollar";
import {
  DEFAULT_REGISTRY_PLAN_CONFIG,
  OPEN_CARD_ACTION_ID,
  applyChatSent,
  applyNotificationCancelled,
  applyNotificationFailure,
  applyNotificationScheduled,
  applyRegistrationResult,
  applyRegistrationSubmitted,
  applyScratched,
  applyTick,
  emptyRegistry,
  planChatMessages,
  planNotificationActions,
  planRegistrations,
  reconcileRegistry,
  sanitizeRegistry,
  type ChatAction,
  type ChatCopy,
  type DailyDollarRegistry,
  type DrawRecord,
  type NotificationPlanOptions,
  type RegistryCopy,
  type WorkerAction,
} from "./registry";

const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CONFIG = DEFAULT_REGISTRY_PLAN_CONFIG;
const NOW = 1_000_000;

function eventId(index: number): Hex32 {
  return `0x${index.toString(16).padStart(64, "0")}` as Hex32;
}

const EVENT_A = eventId(1);
const EVENT_B = eventId(2);

const COPY: RegistryCopy = {
  claimWindow: (record) => `Reminder ${record.eventId}`,
  won: (record) => `You won ${record.prizeAmount}`,
  missed: () => "missed",
};

const CHAT_COPY: ChatCopy = {
  scratchable: (record) => ({ text: `scratch ${record.eventId}` }),
  wonResult: (record) => ({ text: `won ${record.prizeAmount}` }),
  missResult: () => ({ text: "missed" }),
};

function draw(overrides: Partial<AirdropDraw> = {}): AirdropDraw {
  return {
    eventId: EVENT_A,
    drawIndex: 7n,
    status: "Registering",
    registrationStartsSeconds: NOW - 1_000,
    drawTimeSeconds: NOW + 1_000,
    endTimeSeconds: NOW + 10_000,
    prizeAmount: 1_000_000n,
    assetId: null,
    maxWinners: 10,
    totalParticipants: 3,
    effectiveWinners: null,
    claimed: null,
    ...overrides,
  };
}

function participation(
  overrides: Partial<AirdropParticipation> = {},
): AirdropParticipation {
  return {
    draw: draw(),
    slot: eventId(99),
    registered: false,
    winner: false,
    claimed: null,
    ...overrides,
  };
}

function standingOf(participations: AirdropParticipation[]): AirdropStanding {
  return {
    accountAddress: ACCOUNT,
    participations,
    alias: eventId(42),
    airdropsContext: eventId(43),
    aliasContext: eventId(43),
    contextMatches: true,
    atBlockHash: eventId(44),
  };
}

function record(overrides: Partial<DrawRecord> = {}): DrawRecord {
  return {
    eventId: EVENT_A,
    drawIndex: "7",
    status: "Registering",
    drawTimeSeconds: NOW + 1_000,
    endTimeSeconds: NOW + 10_000,
    prizeAmount: "1000000",
    registration: {
      state: "none",
      source: "chain",
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
    announced: [],
    updatedAtSeconds: NOW,
    ...overrides,
  };
}

function registryOf(records: DrawRecord[]): DailyDollarRegistry {
  const draws: Record<Hex32, DrawRecord> = {};
  for (const entry of records) draws[entry.eventId] = entry;
  return { ...emptyRegistry(ACCOUNT), draws };
}

function serialized(registry: DailyDollarRegistry): Record<string, unknown> {
  return JSON.parse(JSON.stringify(registry)) as Record<string, unknown>;
}

/** A handle as stored before links were recorded: no `deeplink` key at all. */
function unrecorded<T extends { deeplink?: string | null }>(entry: T): Omit<T, "deeplink"> {
  const copy = { ...entry };
  delete copy.deeplink;
  return copy;
}

/** The same stored object with its keys written in the opposite order. */
function keysReversed(entry: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).reverse());
}

describe("sanitizeRegistry", () => {
  it("replaces a registry written by another version", () => {
    const stored = { ...serialized(registryOf([record()])), version: 0 };

    expect(sanitizeRegistry(stored, ACCOUNT)).toEqual(emptyRegistry(ACCOUNT));
  });

  it("replaces a registry belonging to another account", () => {
    const stored = serialized(registryOf([record()]));

    expect(sanitizeRegistry(stored, "5Other")).toEqual(emptyRegistry("5Other"));
  });

  it("returns an empty registry for junk", () => {
    expect(sanitizeRegistry(null, ACCOUNT)).toEqual(emptyRegistry(ACCOUNT));
    expect(sanitizeRegistry([1, 2], ACCOUNT)).toEqual(emptyRegistry(ACCOUNT));
    expect(sanitizeRegistry("nope", ACCOUNT)).toEqual(emptyRegistry(ACCOUNT));
  });

  it("keeps well-formed records and drops malformed ones individually", () => {
    const good = record({ eventId: EVENT_A });
    const stored = serialized(registryOf([good])) as {
      draws: Record<string, unknown>;
    };
    stored.draws[EVENT_B] = { ...record({ eventId: EVENT_B }), status: "Nope" };
    stored.draws[eventId(3)] = {
      ...record({ eventId: eventId(3) }),
      drawTimeSeconds: "soon",
    };
    stored.draws[eventId(4)] = {
      ...record({ eventId: eventId(4) }),
      registration: { state: "none" },
    };
    stored.draws["not-an-event-id"] = record({ eventId: EVENT_A });

    const parsed = sanitizeRegistry(stored, ACCOUNT);

    expect(Object.keys(parsed.draws)).toEqual([EVENT_A]);
    expect(parsed.draws[EVENT_A]).toEqual(good);
  });

  it("drops only the malformed notification, not its record", () => {
    const stored = serialized(
      registryOf([
        record({
          notifications: [
            { kind: "claim-window", id: 4, scheduledAtMs: 5_000, text: "hi" },
          ],
        }),
      ]),
    ) as { draws: Record<string, { notifications: unknown[] }> };
    stored.draws[EVENT_A]?.notifications.push({ kind: "bogus", id: 9 });

    const parsed = sanitizeRegistry(stored, ACCOUNT);

    expect(parsed.draws[EVENT_A]?.notifications).toEqual([
      { kind: "claim-window", id: 4, scheduledAtMs: 5_000, text: "hi" },
    ]);
  });

  it("defaults the chat fields for a record written before the worker spoke", () => {
    const stored = serialized(registryOf([record()])) as {
      draws: Record<string, Record<string, unknown>>;
    };
    delete stored.draws[EVENT_A]?.["scratchedAtSeconds"];
    delete stored.draws[EVENT_A]?.["announced"];

    const parsed = sanitizeRegistry(stored, ACCOUNT);

    // Rejecting the record would forget a registration and pay to make it
    // again, so the missing fields default instead.
    expect(parsed.draws[EVENT_A]).toEqual(record());
  });

  it("keeps the chat kinds it knows and drops the ones it does not", () => {
    const stored = serialized(registryOf([record()])) as {
      draws: Record<string, Record<string, unknown>>;
    };
    stored.draws[EVENT_A] = {
      ...stored.draws[EVENT_A],
      announced: ["result", "registered", 7, "result"],
      scratchedAtSeconds: "soon",
    };

    const parsed = sanitizeRegistry(stored, ACCOUNT);

    // `registered` is a kind this build can never post and never clear, and
    // a duplicate would announce twice; both are dropped rather than costing
    // the whole record.
    expect(parsed.draws[EVENT_A]?.announced).toEqual(["result"]);
    expect(parsed.draws[EVENT_A]?.scratchedAtSeconds).toBeNull();
  });

  it("keeps a notification's link when it is a string or null and drops any other", () => {
    const link = "https://peopl.paseo/-/pocket/open?card=jollity";
    const stored = serialized(registryOf([record()])) as {
      draws: Record<string, { notifications: unknown[] }>;
    };
    stored.draws[EVENT_A]?.notifications.push(
      keysReversed({ kind: "claim-window", id: 1, scheduledAtMs: 5_000, text: "a", deeplink: link }),
      keysReversed({ kind: "won", id: 2, scheduledAtMs: 6_000, text: "b", deeplink: null }),
      keysReversed({ kind: "missed", id: 3, scheduledAtMs: 7_000, text: "c", deeplink: 7 }),
      keysReversed({ kind: "missed", id: 4, scheduledAtMs: 8_000, text: "d" }),
    );

    const notifications = sanitizeRegistry(stored, ACCOUNT).draws[EVENT_A]?.notifications ?? [];

    // A link of any other type is not a tap target: the handle stays, without
    // the key, so the planner books it again under the current link.
    expect(notifications.map((notification) => Object.keys(notification))).toEqual([
      ["kind", "id", "scheduledAtMs", "text", "deeplink"],
      ["kind", "id", "scheduledAtMs", "text", "deeplink"],
      ["kind", "id", "scheduledAtMs", "text"],
      ["kind", "id", "scheduledAtMs", "text"],
    ]);
    expect(JSON.stringify(notifications)).toBe(
      JSON.stringify([
        { kind: "claim-window", id: 1, scheduledAtMs: 5_000, text: "a", deeplink: link },
        { kind: "won", id: 2, scheduledAtMs: 6_000, text: "b", deeplink: null },
        { kind: "missed", id: 3, scheduledAtMs: 7_000, text: "c" },
        { kind: "missed", id: 4, scheduledAtMs: 8_000, text: "d" },
      ]),
    );
  });

  it("stores a record's fields in a fixed order, the chat list before the update stamp", () => {
    const stored = serialized(registryOf([record()])) as {
      draws: Record<string, Record<string, unknown>>;
    };
    stored.draws[EVENT_A] = keysReversed({
      ...stored.draws[EVENT_A],
      announced: ["scratchable", "result", "scratchable"],
    });

    const parsed = sanitizeRegistry(stored, ACCOUNT).draws[EVENT_A];

    expect(Object.keys(parsed ?? {})).toEqual([
      "eventId",
      "drawIndex",
      "status",
      "drawTimeSeconds",
      "endTimeSeconds",
      "prizeAmount",
      "registration",
      "outcome",
      "notifications",
      "notificationError",
      "notificationRetrySeconds",
      "scratchedAtSeconds",
      "announced",
      "updatedAtSeconds",
    ]);
    expect(JSON.stringify(parsed)).toBe(
      JSON.stringify(record({ announced: ["scratchable", "result"] })),
    );
  });

  it("keeps a well-formed tick and drops a malformed one", () => {
    const withTick = applyTick(registryOf([]), {
      atSeconds: NOW,
      result: "ok",
      error: null,
    });
    expect(sanitizeRegistry(serialized(withTick), ACCOUNT).lastTick).toEqual({
      atSeconds: NOW,
      result: "ok",
      error: null,
    });

    const badTick = {
      ...serialized(withTick),
      lastTick: { atSeconds: NOW, result: "maybe", error: null },
    };
    expect(sanitizeRegistry(badTick, ACCOUNT).lastTick).toBeNull();
  });
});

describe("reconcileRegistry", () => {
  it("adopts a registration the chain already shows", () => {
    const next = reconcileRegistry(
      emptyRegistry(ACCOUNT),
      standingOf([participation({ registered: true })]),
      NOW,
      CONFIG,
    );

    expect(next.draws[EVENT_A]?.registration.state).toBe("registered");
    expect(next.draws[EVENT_A]?.registration.source).toBe("chain");
    expect(next.draws[EVENT_A]?.drawIndex).toBe("7");
    expect(next.draws[EVENT_A]?.prizeAmount).toBe("1000000");
  });

  it("keeps the submitter's provenance when the chain confirms the entry", () => {
    const submitted = registryOf([
      record({
        registration: {
          ...record().registration,
          state: "submitted",
          source: "worker",
        },
      }),
    ]);

    const next = reconcileRegistry(
      submitted,
      standingOf([participation({ registered: true })]),
      NOW,
      CONFIG,
    );

    expect(next.draws[EVENT_A]?.registration.state).toBe("registered");
    expect(next.draws[EVENT_A]?.registration.source).toBe("worker");
  });

  it("attributes a registration no side recorded to the chain", () => {
    const failed = registryOf([
      record({
        registration: { ...record().registration, state: "failed", source: "app" },
      }),
    ]);

    const next = reconcileRegistry(
      failed,
      standingOf([participation({ registered: true })]),
      NOW,
      CONFIG,
    );

    expect(next.draws[EVENT_A]?.registration.source).toBe("chain");
  });

  it("leaves the outcome pending while the draw is open", () => {
    const next = reconcileRegistry(
      emptyRegistry(ACCOUNT),
      standingOf([participation({ registered: true })]),
      NOW,
      CONFIG,
    );

    expect(next.draws[EVENT_A]?.outcome).toBe("pending");
  });

  it("records a win, a miss, a claim and an expiry", () => {
    const claiming = draw({ status: "Claiming" });
    const cases: [AirdropParticipation, string][] = [
      [participation({ draw: claiming, registered: true, winner: true }), "won"],
      [participation({ draw: claiming, registered: true, winner: false }), "miss"],
      [
        participation({
          draw: claiming,
          registered: true,
          winner: false,
          claimed: true,
        }),
        "claimed",
      ],
      [
        participation({
          draw: draw({ status: "ClearingWinners" }),
          registered: true,
          winner: null,
        }),
        "expired",
      ],
    ];

    for (const [entry, expected] of cases) {
      const next = reconcileRegistry(
        emptyRegistry(ACCOUNT),
        standingOf([entry]),
        NOW,
        CONFIG,
      );
      expect(next.draws[EVENT_A]?.outcome).toBe(expected);
    }
  });

  it("expires a draw whose end time has passed even while it reads Claiming", () => {
    const next = reconcileRegistry(
      emptyRegistry(ACCOUNT),
      standingOf([
        participation({
          draw: draw({ status: "Claiming", endTimeSeconds: NOW - 1 }),
          registered: null,
          winner: null,
        }),
      ]),
      NOW,
      CONFIG,
    );

    expect(next.draws[EVENT_A]?.outcome).toBe("expired");
  });

  it("never walks a recorded win back to pending or miss", () => {
    const won = registryOf([record({ outcome: "won", status: "Claiming" })]);

    const stillOpen = reconcileRegistry(
      won,
      standingOf([participation({ registered: true, winner: null })]),
      NOW,
      CONFIG,
    );
    expect(stillOpen.draws[EVENT_A]?.outcome).toBe("won");

    // The pallet deletes the winner entry on claim, so a post-claim read of a
    // won draw is indistinguishable from a loss.
    const afterClaim = reconcileRegistry(
      won,
      standingOf([
        participation({
          draw: draw({ status: "Claiming" }),
          registered: true,
          winner: false,
        }),
      ]),
      NOW,
      CONFIG,
    );
    expect(afterClaim.draws[EVENT_A]?.outcome).toBe("won");
  });

  it("keeps a claimed outcome once the draw is cleared", () => {
    const claimed = registryOf([record({ outcome: "claimed" })]);

    const next = reconcileRegistry(
      claimed,
      standingOf([
        participation({
          draw: draw({ status: "Finalizing" }),
          registered: null,
          winner: null,
        }),
      ]),
      NOW,
      CONFIG,
    );

    expect(next.draws[EVENT_A]?.outcome).toBe("claimed");
  });

  it("keeps records the standing no longer lists until retention passes", () => {
    const registry = registryOf([
      record({ eventId: EVENT_A, endTimeSeconds: NOW - 10 }),
      record({
        eventId: EVENT_B,
        endTimeSeconds: NOW - CONFIG.retentionSeconds - 1,
      }),
    ]);

    const next = reconcileRegistry(registry, standingOf([]), NOW, CONFIG);

    expect(Object.keys(next.draws)).toEqual([EVENT_A]);
  });

  it("does not mutate the registry it was given", () => {
    const registry = registryOf([record()]);
    const before = JSON.stringify(registry);

    reconcileRegistry(
      registry,
      standingOf([participation({ registered: true })]),
      NOW,
      CONFIG,
    );

    expect(JSON.stringify(registry)).toBe(before);
  });

  it("carries the chat state through a refreshed draw", () => {
    // A reconcile that rebuilt the record from the standing alone would drop
    // the dedupe and the scratch stamp, and the worker would announce the
    // same draw again on the next sweep.
    const registry = registryOf([
      record({
        status: "Claiming",
        outcome: "won",
        scratchedAtSeconds: NOW - 10,
        announced: ["scratchable"],
      }),
    ]);

    const next = reconcileRegistry(
      registry,
      standingOf([
        participation({
          draw: draw({ status: "Claiming" }),
          registered: true,
          winner: true,
        }),
      ]),
      NOW,
      CONFIG,
    );

    expect(next.draws[EVENT_A]?.scratchedAtSeconds).toBe(NOW - 10);
    expect(next.draws[EVENT_A]?.announced).toEqual(["scratchable"]);
  });
});

describe("planRegistrations", () => {
  const open = standingOf([participation()]);

  it("registers a draw with no record yet", () => {
    expect(planRegistrations(emptyRegistry(ACCOUNT), open, NOW)).toEqual([
      EVENT_A,
    ]);
  });

  it("skips a draw that is registered, or submitted or unknown within an attempt's lifetime", () => {
    for (const state of ["submitted", "registered", "unknown"] as const) {
      const registry = registryOf([
        record({ registration: { ...record().registration, state, lastAttemptSeconds: NOW } }),
      ]);

      expect(planRegistrations(registry, open, NOW + CONFIG.stuckRegistrationSeconds - 1, CONFIG)).toEqual([]);
    }
  });

  it("plans a submitted or unknown registration again once it has outlived any attempt", () => {
    for (const state of ["submitted", "unknown"] as const) {
      const registry = registryOf([
        record({ registration: { ...record().registration, state, lastAttemptSeconds: NOW } }),
      ]);

      expect(planRegistrations(registry, open, NOW + CONFIG.stuckRegistrationSeconds, CONFIG)).toEqual([EVENT_A]);
    }
  });

  it("keeps a submitted registration with no attempt time busy for good", () => {
    const registry = registryOf([
      record({ registration: { ...record().registration, state: "submitted", lastAttemptSeconds: null } }),
    ]);

    expect(planRegistrations(registry, open, NOW + 100_000, CONFIG)).toEqual([]);
  });

  it("never plans a registered draw again, however old", () => {
    const registry = registryOf([
      record({ registration: { ...record().registration, state: "registered", lastAttemptSeconds: NOW } }),
    ]);

    expect(planRegistrations(registry, open, NOW + 100_000, CONFIG)).toEqual([]);
  });

  it("retries a failure only once its backoff has elapsed", () => {
    const failed = (nextAttemptSeconds: number): DailyDollarRegistry =>
      registryOf([
        record({
          registration: {
            ...record().registration,
            state: "failed",
            attempts: 1,
            nextAttemptSeconds,
          },
        }),
      ]);

    expect(planRegistrations(failed(NOW + 1), open, NOW)).toEqual([]);
    expect(planRegistrations(failed(NOW), open, NOW)).toEqual([EVENT_A]);
  });

  it("keeps retrying a failure however many attempts it took", () => {
    const registry = registryOf([
      record({
        registration: {
          ...record().registration,
          state: "failed",
          attempts: 50,
          nextAttemptSeconds: NOW,
        },
      }),
    ]);

    expect(planRegistrations(registry, open, NOW)).toEqual([EVENT_A]);
  });

  it("stops retrying once the draw's registration window has closed", () => {
    const registry = registryOf([
      record({
        registration: { ...record().registration, state: "failed", nextAttemptSeconds: NOW },
      }),
    ]);
    const drawn = standingOf([participation({ draw: draw({ drawTimeSeconds: NOW }) })]);

    expect(planRegistrations(registry, drawn, NOW)).toEqual([]);
  });

  it("does not register a draw the standing no longer offers", () => {
    expect(
      planRegistrations(emptyRegistry(ACCOUNT), standingOf([]), NOW),
    ).toEqual([]);
  });
});

describe("planNotificationActions", () => {
  const registered = (overrides: Partial<DrawRecord> = {}): DrawRecord =>
    record({
      registration: { ...record().registration, state: "registered" },
      ...overrides,
    });

  /** The link pushes are booked with in these cases. */
  const LINK = "polkadotapp://pocket/open?product=peopl.paseo&card=humanity&open=scratch";

  /** The whole notification plan at `NOW`, with the win push enabled unless
   *  the caller says otherwise. */
  const planAll = (
    registry: DailyDollarRegistry,
    options: NotificationPlanOptions = { won: true, deeplink: LINK },
  ): WorkerAction[] =>
    planNotificationActions(registry, NOW, CONFIG, COPY, options);

  /** The reminder and win half of the plan. The `missed` push rides along on
   *  every unopened registered draw, so it has its own block below. */
  const plan = (
    registry: DailyDollarRegistry,
    options: NotificationPlanOptions = { won: true, deeplink: LINK },
  ): WorkerAction[] =>
    planAll(registry, options).filter((action) => action.type === "register" || action.kind !== "missed");

  const futureReminder = {
    kind: "claim-window" as const,
    id: 11,
    scheduledAtMs: (NOW + 60) * 1_000,
    text: "x",
    deeplink: LINK,
  };

  it("schedules the claim-window reminder after the draw plus the grace", () => {
    expect(plan(registryOf([registered()]))).toEqual([
      {
        type: "schedule",
        eventId: EVENT_A,
        kind: "claim-window",
        atMs: (NOW + 1_000 + CONFIG.claimWindowGraceSeconds) * 1_000,
        text: `Reminder ${EVENT_A}`,
      },
    ]);
  });

  it("skips a reminder whose moment has already passed", () => {
    const registry = registryOf([
      registered({ drawTimeSeconds: NOW - CONFIG.claimWindowGraceSeconds }),
    ]);

    expect(plan(registry)).toEqual([]);
  });

  it("skips a record that already holds a claim-window handle", () => {
    const registry = registryOf([
      registered({
        notifications: [{ ...futureReminder, scheduledAtMs: (NOW + 2_000) * 1_000 }],
      }),
    ]);

    expect(plan(registry)).toEqual([]);
  });

  it("holds off while a push failure is still backing off", () => {
    const blocked = registryOf([registered({ notificationRetrySeconds: NOW + 1 })]);
    expect(plan(blocked)).toEqual([]);

    const due = registryOf([registered({ notificationRetrySeconds: NOW })]);
    expect(plan(due)).toHaveLength(1);
  });

  it("skips statuses where the draw has already resolved", () => {
    for (const status of ["Scheduled", "Claiming"] as AirdropDrawStatus[]) {
      expect(plan(registryOf([registered({ status })]))).toEqual([]);
    }
  });

  it("keeps a winner's pending reminder instead of telling them early", () => {
    // Cancelling it for an immediate push would reach winners before
    // everyone else's reminder fires: the timing alone gives the result away.
    const registry = registryOf([
      registered({
        status: "Claiming",
        outcome: "won",
        notifications: [futureReminder],
      }),
    ]);

    expect(plan(registry)).toEqual([]);
  });

  it("sends no second push to a winner whose reminder already fired", () => {
    const registry = registryOf([
      registered({
        status: "Claiming",
        outcome: "won",
        notifications: [{ ...futureReminder, scheduledAtMs: (NOW - 60) * 1_000 }],
      }),
    ]);

    expect(plan(registry)).toEqual([]);
  });

  it("pushes now for a win that never had a reminder", () => {
    const registry = registryOf([registered({ status: "Claiming", outcome: "won" })]);

    expect(plan(registry)).toEqual([
      {
        type: "schedule",
        eventId: EVENT_A,
        kind: "won",
        atMs: null,
        text: "You won 1000000",
      },
    ]);
  });

  it("cancels only still-future notifications once the draw is settled", () => {
    for (const outcome of ["miss", "claimed", "expired"] as const) {
      const registry = registryOf([
        registered({
          status: "Claiming",
          outcome,
          notifications: [
            { ...futureReminder, id: 21, scheduledAtMs: (NOW + 30) * 1_000 },
            { kind: "won", id: 22, scheduledAtMs: (NOW - 30) * 1_000, text: "y" },
          ],
        }),
      ]);

      expect(plan(registry)).toEqual([
        { type: "cancel", eventId: EVENT_A, kind: "claim-window", id: 21 },
      ]);
    }
  });

  it("plans nothing new once the planned actions have been applied", () => {
    const registry = registryOf([registered()]);
    const [action] = plan(registry);
    if (action?.type !== "schedule") throw new Error("expected a schedule action");

    const applied = applyNotificationScheduled(
      registry,
      action.eventId,
      {
        kind: action.kind,
        id: 3,
        scheduledAtMs: action.atMs ?? NOW * 1_000,
        text: action.text,
        deeplink: LINK,
      },
      NOW,
    );

    expect(plan(applied)).toEqual([]);
  });

  it("plans nothing new once the win notice has been pushed", () => {
    const registry = registryOf([registered({ status: "Claiming", outcome: "won" })]);
    const pushed = applyNotificationScheduled(
      registry,
      EVENT_A,
      { kind: "won", id: 5, scheduledAtMs: NOW * 1_000, text: "You won 1000000" },
      NOW,
    );

    expect(plan(pushed)).toEqual([]);
  });

  it("holds the win notice back while a push failure is still backing off", () => {
    const registry = registryOf([
      registered({
        status: "Claiming",
        outcome: "won",
        notificationRetrySeconds: NOW + 1,
        notifications: [futureReminder],
      }),
    ]);

    // The reminder stays scheduled: it is only cancelled by the notice that
    // replaces it, and that notice is not being pushed this pass - so for now
    // the reminder is the only thing that would still reach the person.
    expect(plan(registry)).toEqual([]);
  });

  it("never pushes the win notice for a caller that tells the person on screen", () => {
    const registry = registryOf([registered({ status: "Claiming", outcome: "won" })]);

    expect(plan(registry, { won: false, deeplink: LINK })).toEqual([]);
  });

  it("keeps an unopened winner's reminder when the app is open", () => {
    const registry = registryOf([
      registered({
        status: "Claiming",
        outcome: "won",
        notifications: [futureReminder],
      }),
    ]);

    // The reminder is the "window is open" push every entrant gets at the
    // same moment; the app dropping it for winners only is what made the
    // worker push late, after the card was scratched.
    expect(plan(registry, { won: false, deeplink: LINK })).toEqual([]);
  });

  it("cancels a pending reminder once the card is scratched, win or miss", () => {
    for (const outcome of ["won", "miss"] as const) {
      const registry = registryOf([
        registered({
          status: "Claiming",
          outcome,
          scratchedAtSeconds: NOW,
          notifications: [futureReminder],
        }),
      ]);

      for (const won of [true, false]) {
        expect(plan(registry, { won, deeplink: LINK })).toEqual([
          { type: "cancel", eventId: EVENT_A, kind: "claim-window", id: 11 },
        ]);
      }
    }
  });

  it("never pushes the win notice for a card already scratched", () => {
    const registry = registryOf([
      registered({ status: "Claiming", outcome: "won", scratchedAtSeconds: NOW }),
    ]);

    expect(plan(registry)).toEqual([]);
  });

  it("sends no late win push after the app has seen the win and the card was scratched", () => {
    // The field report: the app saw the win, the person scratched, and the
    // worker's next tick then pushed "Scratch now". Run the app pass, then the
    // scratch, then the worker pass, applying each plan as the sweep would.
    let registry = registryOf([
      registered({ status: "Claiming", outcome: "won", notifications: [futureReminder] }),
    ]);
    for (const action of plan(registry, { won: false, deeplink: LINK })) {
      if (action.type === "cancel") {
        registry = applyNotificationCancelled(registry, action.eventId, action.kind, NOW);
      }
    }
    registry = applyScratched(registry, EVENT_A, NOW);

    expect(plan(registry).filter((action) => action.type === "schedule")).toEqual([]);
  });

  it("still clears a settled draw's future reminder without the win push", () => {
    const registry = registryOf([
      registered({
        status: "Claiming",
        outcome: "miss",
        notifications: [futureReminder],
      }),
    ]);

    expect(plan(registry, { won: false, deeplink: LINK })).toEqual([
      { type: "cancel", eventId: EVENT_A, kind: "claim-window", id: 11 },
    ]);
  });

  describe("a push booked under another link", () => {
    const OLD = "https://peopl.paseo/-/pocket/open?card=humanity";

    it("is booked again at the same moment with the same words, for winner and loser alike", () => {
      for (const outcome of ["pending", "won"] as const) {
        const registry = registryOf([
          registered({
            status: outcome === "won" ? "Claiming" : "Registering",
            outcome,
            notifications: [{ ...futureReminder, deeplink: OLD }],
          }),
        ]);

        for (const won of [true, false]) {
          expect(plan(registry, { won, deeplink: LINK })).toEqual([
            {
              type: "rebook",
              eventId: EVENT_A,
              kind: "claim-window",
              id: 11,
              atMs: futureReminder.scheduledAtMs,
              text: "x",
            },
          ]);
        }
      }
    });

    it("is booked again when it predates recorded links", () => {
      const registry = registryOf([registered({ notifications: [unrecorded(futureReminder)] })]);

      expect(plan(registry)).toEqual([
        expect.objectContaining({ type: "rebook", kind: "claim-window", id: 11 }),
      ]);
    });

    it("is left alone once it has fired", () => {
      const fired = { ...futureReminder, deeplink: OLD, scheduledAtMs: (NOW - 60) * 1_000 };
      const registry = registryOf([registered({ notifications: [fired] })]);

      expect(plan(registry)).toEqual([]);
    });

    it("is cancelled rather than booked again once it is no longer wanted", () => {
      const registry = registryOf([
        registered({
          status: "Claiming",
          outcome: "miss",
          notifications: [{ ...futureReminder, deeplink: OLD }],
        }),
      ]);

      expect(plan(registry)).toEqual([
        { type: "cancel", eventId: EVENT_A, kind: "claim-window", id: 11 },
      ]);
    });

    it("is left alone by a caller that has no link to book it under", () => {
      const registry = registryOf([
        registered({
          notifications: [
            { ...futureReminder, deeplink: OLD },
            { kind: "missed", id: 12, scheduledAtMs: (NOW + 10_000) * 1_000, text: "missed", deeplink: OLD },
          ],
        }),
      ]);

      expect(planAll(registry, { won: true, deeplink: null })).toEqual([]);
    });

    it("waits out a push failure's backoff", () => {
      const registry = registryOf([
        registered({
          notifications: [{ ...futureReminder, deeplink: OLD }],
          notificationRetrySeconds: NOW + 60,
        }),
      ]);

      expect(plan(registry)).toEqual([]);
    });
  });

  describe("the missed push", () => {
    const missedAt = (NOW + 10_000) * 1_000;
    const pendingMissed = {
      kind: "missed" as const,
      id: 31,
      scheduledAtMs: missedAt,
      text: "missed",
      deeplink: LINK,
    };
    const missedOnly = (registry: DailyDollarRegistry, options?: NotificationPlanOptions) =>
      planAll(registry, options).filter(
        (action) => action.type !== "register" && action.kind === "missed",
      );

    it("is scheduled for the end of the claim window at registration", () => {
      expect(missedOnly(registryOf([registered()]))).toEqual([
        { type: "schedule", eventId: EVENT_A, kind: "missed", atMs: missedAt, text: "missed" },
      ]);
    });

    it("is still scheduled for an unopened ticket, win or miss", () => {
      for (const outcome of ["won", "miss"] as const) {
        const registry = registryOf([registered({ status: "Claiming", outcome })]);
        expect(missedOnly(registry)).toHaveLength(1);
      }
    });

    it("is never scheduled once the card is opened, claimed or the window shut", () => {
      for (const overrides of [
        { status: "Claiming" as const, outcome: "miss" as const, scratchedAtSeconds: NOW },
        { status: "Claiming" as const, outcome: "claimed" as const },
        { endTimeSeconds: NOW },
      ]) {
        expect(missedOnly(registryOf([registered(overrides)]))).toEqual([]);
      }
    });

    it("is not scheduled twice", () => {
      expect(missedOnly(registryOf([registered({ notifications: [pendingMissed] })]))).toEqual([]);
    });

    it("stays scheduled through a miss the person has not opened", () => {
      const registry = registryOf([
        registered({ status: "Claiming", outcome: "miss", notifications: [pendingMissed] }),
      ]);

      expect(missedOnly(registry, { won: false, deeplink: LINK })).toEqual([]);
    });

    it("is cancelled once the card is scratched or claimed", () => {
      for (const overrides of [
        { outcome: "miss" as const, scratchedAtSeconds: NOW },
        { outcome: "won" as const, scratchedAtSeconds: NOW },
        { outcome: "claimed" as const },
      ]) {
        const registry = registryOf([
          registered({ status: "Claiming", notifications: [pendingMissed], ...overrides }),
        ]);
        expect(missedOnly(registry)).toEqual([
          { type: "cancel", eventId: EVENT_A, kind: "missed", id: 31 },
        ]);
      }
    });

    it("replaces a pending push queued under older copy", () => {
      const registry = registryOf([
        registered({ status: "Claiming", notifications: [{ ...pendingMissed, text: "old" }] }),
      ]);

      expect(missedOnly(registry)).toEqual([
        { type: "rebook", eventId: EVENT_A, kind: "missed", id: 31, atMs: missedAt, text: "missed" },
      ]);
    });

    it("replaces a pending push booked under another link, or before links were recorded", () => {
      for (const booked of [
        { ...pendingMissed, deeplink: "https://peopl.paseo/-/pocket/open?card=humanity" },
        { ...pendingMissed, deeplink: null },
        unrecorded(pendingMissed),
      ]) {
        const registry = registryOf([registered({ notifications: [booked] })]);

        expect(missedOnly(registry)).toEqual([
          { type: "rebook", eventId: EVENT_A, kind: "missed", id: 31, atMs: missedAt, text: "missed" },
        ]);
      }
    });

    it("waits out a push failure's backoff before replacing it", () => {
      const registry = registryOf([
        registered({
          notifications: [{ ...pendingMissed, deeplink: "https://old" }],
          notificationRetrySeconds: NOW + 60,
        }),
      ]);

      expect(missedOnly(registry)).toEqual([]);
    });

    it("leaves an already-fired push alone, whatever it said", () => {
      const fired = { ...pendingMissed, text: "old", scheduledAtMs: NOW * 1_000 };
      const registry = registryOf([registered({ status: "Claiming", notifications: [fired] })]);

      expect(missedOnly(registry)).toEqual([]);
    });
  });
});

describe("planChatMessages", () => {
  const resolved = (overrides: Partial<DrawRecord> = {}): DrawRecord =>
    record({ status: "Claiming", outcome: "won", ...overrides });

  const plan = (registry: DailyDollarRegistry, nowSeconds = NOW): ChatAction[] =>
    planChatMessages(registry, nowSeconds, CHAT_COPY);

  it("invites a scratch for an unopened win and an unopened miss", () => {
    const [invite] = plan(registryOf([resolved()]));
    expect(invite).toEqual({ eventId: EVENT_A, kind: "scratchable", text: `scratch ${EVENT_A}` });
    expect(invite).not.toHaveProperty("buttons");
    expect(plan(registryOf([resolved({ outcome: "miss" })]))).toEqual([
      { eventId: EVENT_A, kind: "scratchable", text: `scratch ${EVENT_A}` },
    ]);
  });

  it("carries the copy's buttons onto the invitation", () => {
    const buttons = [{ actionId: OPEN_CARD_ACTION_ID, title: "Scratch" }];
    const copy: ChatCopy = {
      ...CHAT_COPY,
      scratchable: (record) => ({ text: `scratch ${record.eventId}`, buttons }),
    };

    expect(planChatMessages(registryOf([resolved()]), NOW, copy)).toEqual([
      { eventId: EVENT_A, kind: "scratchable", text: `scratch ${EVENT_A}`, buttons },
    ]);
  });

  it("reports the result once the card has been opened", () => {
    const won = registryOf([resolved({ scratchedAtSeconds: NOW - 10 })]);
    expect(plan(won)).toEqual([
      { eventId: EVENT_A, kind: "result", text: "won 1000000" },
    ]);

    const missed = registryOf([
      resolved({ outcome: "miss", scratchedAtSeconds: NOW - 10 }),
    ]);
    expect(plan(missed)).toEqual([
      { eventId: EVENT_A, kind: "result", text: "missed" },
    ]);
  });

  it("invites a scratch for a win the app banked before the card was opened", () => {
    // The auto-claim submits the claim the moment a win is claimable, so
    // `claimed` says nothing about the card. Announcing the result here
    // would tell the person how a card they never touched went.
    const banked = registryOf([resolved({ outcome: "claimed" })]);

    expect(plan(banked)).toEqual([
      { eventId: EVENT_A, kind: "scratchable", text: `scratch ${EVENT_A}` },
    ]);
    expect(plan(banked, NOW + 10_000)).toEqual([]);
  });

  it("reports a banked win once the card has been opened", () => {
    const opened = registryOf([
      resolved({ outcome: "claimed", scratchedAtSeconds: NOW - 10 }),
    ]);

    expect(plan(opened)).toEqual([
      { eventId: EVENT_A, kind: "result", text: "won 1000000" },
    ]);
  });

  it("says nothing twice", () => {
    const invited = registryOf([resolved({ announced: ["scratchable"] })]);
    expect(plan(invited)).toEqual([]);

    const reported = registryOf([
      resolved({ scratchedAtSeconds: NOW - 10, announced: ["result"] }),
    ]);
    expect(plan(reported)).toEqual([]);
  });

  it("still reports the result of a ticket it already invited", () => {
    const registry = registryOf([
      resolved({ scratchedAtSeconds: NOW - 10, announced: ["scratchable"] }),
    ]);

    expect(plan(registry)).toEqual([
      { eventId: EVENT_A, kind: "result", text: "won 1000000" },
    ]);
  });

  it("stops inviting a scratch once the claim window has shut", () => {
    const registry = registryOf([resolved()]);

    expect(plan(registry, NOW + 10_000)).toEqual([]);
  });

  it("says nothing about a draw that has not resolved or has expired", () => {
    for (const outcome of ["pending", "expired"] as const) {
      expect(plan(registryOf([resolved({ outcome })]))).toEqual([]);
      expect(
        plan(registryOf([resolved({ outcome, scratchedAtSeconds: NOW - 10 })])),
      ).toEqual([]);
    }
  });

  it("speaks about the oldest draw first", () => {
    // Object key order follows insertion, and a registry rebuilt from a
    // standing can hold yesterday's draw after today's. Chat is a
    // transcript: it has to read in the order things happened.
    const registry = registryOf([
      resolved({ eventId: EVENT_B, drawIndex: "10" }),
      resolved({ eventId: EVENT_A, drawIndex: "9" }),
    ]);

    expect(plan(registry).map((action) => action.eventId)).toEqual([
      EVENT_A,
      EVENT_B,
    ]);
  });
});

describe("registration reducers", () => {
  it("counts a worker submission and not an app one", () => {
    const worker = applyRegistrationSubmitted(
      emptyRegistry(ACCOUNT),
      [EVENT_A],
      "worker",
      NOW,
    );
    expect(worker.draws[EVENT_A]?.registration).toMatchObject({
      state: "submitted",
      source: "worker",
      attempts: 1,
      lastAttemptSeconds: NOW,
    });

    const app = applyRegistrationSubmitted(
      emptyRegistry(ACCOUNT),
      [EVENT_A],
      "app",
      NOW,
    );
    expect(app.draws[EVENT_A]?.registration.attempts).toBe(0);
  });

  it("creates a minimal record for an event id it has never seen", () => {
    const next = applyRegistrationResult(
      emptyRegistry(ACCOUNT),
      [EVENT_B],
      { status: "finalized", txHash: "0xdead" },
      "worker",
      NOW,
      CONFIG,
    );

    expect(next.draws[EVENT_B]).toMatchObject({
      eventId: EVENT_B,
      drawIndex: "0",
      status: "Registering",
      drawTimeSeconds: 0,
      endTimeSeconds: 0,
      prizeAmount: "0",
      registration: { state: "registered", source: "worker", txHash: "0xdead" },
    });
  });

  it("walks the backoff forward across worker attempts", () => {
    let registry = emptyRegistry(ACCOUNT);
    const delays: number[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      registry = applyRegistrationSubmitted(registry, [EVENT_A], "worker", NOW);
      registry = applyRegistrationResult(
        registry,
        [EVENT_A],
        { status: "failed", error: "no funds" },
        "worker",
        NOW,
        CONFIG,
      );
      const registration = registry.draws[EVENT_A]?.registration;
      delays.push((registration?.nextAttemptSeconds ?? 0) - NOW);
    }

    // Every delay is the last configured one once the list runs out.
    expect(delays).toEqual(
      [0, 1, 2].map((i) => CONFIG.registerRetryBackoffSeconds[Math.min(i, CONFIG.registerRetryBackoffSeconds.length - 1)]),
    );
    expect(registry.draws[EVENT_A]?.registration).toMatchObject({
      state: "failed",
      attempts: 3,
      error: "no funds",
    });
    expect(
      planRegistrations(registry, standingOf([participation()]), NOW + CONFIG.registerRetryBackoffSeconds.at(-1)!),
    ).toEqual([EVENT_A]);
  });

  it("retries an app failure made shortly before the draw while registration is still open", () => {
    const failedAt = NOW - 102;
    let registry = applyRegistrationSubmitted(emptyRegistry(ACCOUNT), [EVENT_A], "app", failedAt);
    registry = applyRegistrationResult(
      registry,
      [EVENT_A],
      { status: "failed", error: "We couldn't submit your airdrop registration. Try again shortly." },
      "app",
      failedAt,
      CONFIG,
    );
    const closing = standingOf([participation({ draw: draw({ drawTimeSeconds: NOW }) })]);
    const retryAt = registry.draws[EVENT_A]!.registration.nextAttemptSeconds!;

    expect(retryAt).toBeLessThan(NOW);
    expect(planRegistrations(registry, closing, retryAt)).toEqual([EVENT_A]);
  });

  it("keeps an undetermined submission busy forever", () => {
    const registry = applyRegistrationResult(
      applyRegistrationSubmitted(emptyRegistry(ACCOUNT), [EVENT_A], "worker", NOW),
      [EVENT_A],
      { status: "unknown", error: "timed out" },
      "worker",
      NOW,
      CONFIG,
    );

    expect(registry.draws[EVENT_A]?.registration.state).toBe("unknown");
    expect(
      planRegistrations(registry, standingOf([participation()]), NOW + 100_000),
    ).toEqual([]);
  });
});

describe("notification reducers", () => {
  it("replaces the handle of the same kind and clears the failure gate", () => {
    const registry = registryOf([
      record({
        notifications: [
          { kind: "claim-window", id: 1, scheduledAtMs: 1_000, text: "old" },
          { kind: "won", id: 2, scheduledAtMs: 2_000, text: "won" },
        ],
        notificationError: "ScheduleLimitReached",
        notificationRetrySeconds: NOW + 600,
      }),
    ]);

    const next = applyNotificationScheduled(
      registry,
      EVENT_A,
      { kind: "claim-window", id: 9, scheduledAtMs: 5_000, text: "new" },
      NOW,
    );

    expect(next.draws[EVENT_A]?.notifications).toEqual([
      { kind: "won", id: 2, scheduledAtMs: 2_000, text: "won" },
      { kind: "claim-window", id: 9, scheduledAtMs: 5_000, text: "new" },
    ]);
    expect(next.draws[EVENT_A]?.notificationError).toBeNull();
    expect(next.draws[EVENT_A]?.notificationRetrySeconds).toBeNull();
  });

  it("forgets a cancelled handle", () => {
    const registry = registryOf([
      record({
        notifications: [
          { kind: "claim-window", id: 1, scheduledAtMs: 1_000, text: "old" },
        ],
      }),
    ]);

    expect(
      applyNotificationCancelled(registry, EVENT_A, "claim-window", NOW).draws[
        EVENT_A
      ]?.notifications,
    ).toEqual([]);
  });

  it("gates the retry after a push failure", () => {
    const next = applyNotificationFailure(
      registryOf([record()]),
      EVENT_A,
      "ScheduleLimitReached",
      NOW,
      CONFIG,
    );

    expect(next.draws[EVENT_A]?.notificationError).toBe("ScheduleLimitReached");
    expect(next.draws[EVENT_A]?.notificationRetrySeconds).toBe(
      NOW + CONFIG.notificationRetrySeconds,
    );
  });

  it("ignores a handle for a draw it has no record of", () => {
    const registry = registryOf([record()]);

    expect(
      applyNotificationScheduled(
        registry,
        EVENT_B,
        { kind: "won", id: 1, scheduledAtMs: 1, text: "x" },
        NOW,
      ).draws,
    ).toEqual(registry.draws);
  });
});

describe("chat reducers", () => {
  it("stamps the first reveal and leaves a later one alone", () => {
    const scratched = applyScratched(registryOf([record()]), EVENT_A, NOW);
    expect(scratched.draws[EVENT_A]?.scratchedAtSeconds).toBe(NOW);
    expect(scratched.draws[EVENT_A]?.updatedAtSeconds).toBe(NOW);

    // A remount re-fires the reveal callback; re-stamping would move the
    // moment the chat reports for a card opened once.
    const again = applyScratched(scratched, EVENT_A, NOW + 500);
    expect(again.draws[EVENT_A]?.scratchedAtSeconds).toBe(NOW);
  });

  it("ignores a reveal for a draw it has no record of", () => {
    const registry = registryOf([record()]);

    expect(applyScratched(registry, EVENT_B, NOW).draws).toEqual(registry.draws);
  });

  it("records each posted chat kind exactly once", () => {
    const once = applyChatSent(registryOf([record()]), EVENT_A, "scratchable", NOW);
    const twice = applyChatSent(once, EVENT_A, "scratchable", NOW + 60);
    const both = applyChatSent(twice, EVENT_A, "result", NOW + 60);

    expect(once.draws[EVENT_A]?.announced).toEqual(["scratchable"]);
    expect(twice.draws[EVENT_A]?.announced).toEqual(["scratchable"]);
    expect(twice.draws[EVENT_A]?.updatedAtSeconds).toBe(NOW);
    expect(both.draws[EVENT_A]?.announced).toEqual(["scratchable", "result"]);
  });

  it("ignores a posted line for a draw it has no record of", () => {
    const registry = registryOf([record()]);

    expect(applyChatSent(registry, EVENT_B, "result", NOW).draws).toEqual(
      registry.draws,
    );
  });
});

describe("applyTick", () => {
  it("stamps the last tick without touching the records", () => {
    const registry = registryOf([record()]);
    const next = applyTick(registry, {
      atSeconds: NOW,
      result: "error",
      error: "rpc down",
    });

    expect(next.lastTick).toEqual({
      atSeconds: NOW,
      result: "error",
      error: "rpc down",
    });
    expect(next.draws).toEqual(registry.draws);
    expect(registry.lastTick).toBeNull();
  });
});

describe("emptyRegistry", () => {
  it("carries the current schema version", () => {
    expect(emptyRegistry(ACCOUNT)).toEqual({
      version: DAILY_DOLLAR_REGISTRY_VERSION,
      accountAddress: ACCOUNT,
      draws: {},
      lastTick: null,
    });
  });
});
