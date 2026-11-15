// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest";

import {
  runDailyDollarSweep,
  type SweepDeps,
  type SweepNotifications,
  type SweepOutcome,
} from "./sweep";
import type { RegisterDrawsResult } from "./sweep";
import type {
  AirdropDraw,
  AirdropParticipation,
  AirdropStanding,
  Hex32,
} from "@individuality/daily-dollar";
import { DAILY_DOLLAR_COPY } from "./copy";
import {
  applyRegistrationResult,
  applyRegistrationSubmitted,
  applyScratched,
  DEFAULT_REGISTRY_PLAN_CONFIG,
  emptyRegistry,
  type DailyDollarRegistry,
  type DrawRecord,
} from "./registry";

const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CONFIG = DEFAULT_REGISTRY_PLAN_CONFIG;
const NOW = 1_000_000;
const TX_HASH = `0x${"ab".repeat(32)}`;

function eventId(index: number): Hex32 {
  return `0x${index.toString(16).padStart(64, "0")}` as Hex32;
}

const EVENT_A = eventId(1);
const EVENT_B = eventId(2);

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

interface PushRecord {
  text: string;
  deeplink?: string;
  scheduledAtMs: number | null;
}

interface Harness {
  deps: SweepDeps;
  nowSeconds: number;
  standing: AirdropStanding;
  registerResult: (eventIds: Hex32[]) => RegisterDrawsResult;
  registerError: Error | null;
  readError: Error | null;
  pushError: Error | null;
  /** `null` stands for a host with no manager, or a refused permission. */
  host: SweepNotifications | null;
  /** Run as the notification handle is pushed, to land a concurrent write
   *  while the sweep is mid-flight. */
  onPush: (() => void) | null;
  stored: DailyDollarRegistry | null;
  writes: number;
  pushes: PushRecord[];
  cancels: number[];
  registerCalls: Hex32[][];
  /** How many times the sweep asked for the notification handle - on a phone
   *  that is a permission prompt, so it must be zero or one. */
  resolverCalls: number;
  nextNotificationId: number;
}

function createHarness(): Harness {
  const harness: Harness = {
    deps: {} as SweepDeps,
    nowSeconds: NOW,
    standing: standingOf([participation()]),
    registerResult: (eventIds) => [
      { eventIds, status: "finalized", txHash: TX_HASH },
    ],
    registerError: null,
    readError: null,
    pushError: null,
    host: null,
    onPush: null,
    stored: null,
    writes: 0,
    pushes: [],
    cancels: [],
    registerCalls: [],
    resolverCalls: 0,
    nextNotificationId: 1,
  };

  harness.host = {
    push: (input) => {
      harness.pushes.push(input);
      harness.onPush?.();
      if (harness.pushError != null) return Promise.reject(harness.pushError);
      return Promise.resolve(harness.nextNotificationId++);
    },
    cancel: (id) => {
      harness.cancels.push(id);
      return Promise.resolve();
    },
  };

  harness.deps = {
    now: () => harness.nowSeconds,
    registerForDraws: (eventIds) => {
      harness.registerCalls.push([...eventIds]);
      if (harness.registerError != null) return Promise.reject(harness.registerError);
      const results = harness.registerResult(eventIds);
      // What the real `registerForDraws` does before it resolves: record the
      // submitted marker and the outcome in the shared record itself. The
      // sweep leans on that, so the fake has to do it too - otherwise these
      // tests would assert against a store no writer ever touched.
      let next = applyRegistrationSubmitted(
        harness.stored ?? emptyRegistry(ACCOUNT),
        eventIds,
        "worker",
        harness.nowSeconds,
      );
      for (const chunk of results) {
        next = applyRegistrationResult(
          next,
          chunk.eventIds,
          {
            status: chunk.status,
            ...(chunk.txHash == null ? {} : { txHash: chunk.txHash }),
            ...(chunk.error == null
              ? {}
              : {
                  error:
                    chunk.error instanceof Error
                      ? chunk.error.message
                      : String(chunk.error),
                }),
          },
          "worker",
          harness.nowSeconds,
          CONFIG,
        );
      }
      harness.stored = next;
      return Promise.resolve(results);
    },
    notifications: () => {
      harness.resolverCalls += 1;
      return Promise.resolve(harness.host);
    },
    readRegistry: (accountAddress) => {
      if (harness.readError != null) return Promise.reject(harness.readError);
      return Promise.resolve(harness.stored ?? emptyRegistry(accountAddress));
    },
    // Mirrors the store: read-modify-write, so a mutation that landed on
    // `harness.stored` mid-sweep is what the sweep's reducers replay onto.
    updateRegistry: (accountAddress, update) => {
      const next = update(harness.stored ?? emptyRegistry(accountAddress));
      harness.stored = next;
      harness.writes += 1;
      return Promise.resolve(next);
    },
    deeplink: "https://peopl.paseo",
    config: CONFIG,
    copy: DAILY_DOLLAR_COPY,
    won: true,
  };

  return harness;
}

/** One pass over the harness's current standing. */
function sweep(target: Harness = harness): Promise<SweepOutcome> {
  return runDailyDollarSweep(target.deps, ACCOUNT, target.standing);
}

/** The persisted registry after a sweep; fails loudly rather than returning a
 *  placeholder, so an assertion can never pass against an unwritten record. */
function stored(target: Harness = harness): DailyDollarRegistry {
  const registry = target.stored;
  if (registry == null) throw new Error("no registry was written");
  return registry;
}

/** The persisted record for one draw, asserted to exist. */
function recordOf(id: Hex32, target: Harness = harness): DrawRecord {
  const record = stored(target).draws[id];
  if (record == null) throw new Error(`no record written for ${id}`);
  return record;
}

const REGISTERED_AWAITING = standingOf([
  participation({ registered: true, draw: draw({ status: "DrawWinners" }) }),
]);

const WON = standingOf([
  participation({
    registered: true,
    winner: true,
    draw: draw({ status: "Claiming" }),
  }),
]);

/** A handle as stored before links were recorded: no `deeplink` key at all. */
function unrecorded<T extends { deeplink?: string | null }>(entry: T): Omit<T, "deeplink"> {
  const copy = { ...entry };
  delete copy.deeplink;
  return copy;
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

describe("runDailyDollarSweep", () => {
  it("registers for an open draw and records the finalized entry", async () => {
    const { result, actions } = await sweep();

    expect(result).toBe("ok");
    expect(actions).toEqual([{ type: "register", eventIds: [EVENT_A] }]);
    expect(harness.registerCalls).toEqual([[EVENT_A]]);
    expect(recordOf(EVENT_A).registration).toMatchObject({
      state: "registered",
      source: "worker",
      txHash: TX_HASH,
    });
    expect(stored().lastTick).toEqual({
      atSeconds: NOW,
      result: "ok",
      error: null,
    });
    expect(harness.writes).toBe(1);
  });

  it("marks a failed chunk for retry", async () => {
    harness.registerResult = (eventIds) => [
      { eventIds, status: "failed", error: new Error("no signer") },
    ];

    await sweep();

    expect(recordOf(EVENT_A).registration).toMatchObject({
      state: "failed",
      attempts: 1,
      error: "no signer",
      nextAttemptSeconds: NOW + (CONFIG.registerRetryBackoffSeconds[0] ?? 0),
    });
  });

  it("never registers for a caller that has no register handle", async () => {
    harness.deps.registerForDraws = null;

    const { result, actions } = await sweep();

    expect(result).toBe("ok");
    expect(actions).toEqual([]);
    expect(harness.registerCalls).toEqual([]);
  });

  it("schedules the reminder and the missed push for a registered draw, once", async () => {
    harness.standing = REGISTERED_AWAITING;

    await sweep();

    expect(harness.pushes).toEqual([
      {
        text: DAILY_DOLLAR_COPY.claimWindow(recordOf(EVENT_A)),
        deeplink: "https://peopl.paseo",
        scheduledAtMs: (NOW + 1_000 + CONFIG.claimWindowGraceSeconds) * 1_000,
      },
      {
        text: DAILY_DOLLAR_COPY.missed(recordOf(EVENT_A)),
        deeplink: "https://peopl.paseo",
        scheduledAtMs: recordOf(EVENT_A).endTimeSeconds * 1_000,
      },
    ]);
    expect(recordOf(EVENT_A).notifications).toEqual([
      {
        kind: "claim-window",
        id: 1,
        scheduledAtMs: (NOW + 1_000 + CONFIG.claimWindowGraceSeconds) * 1_000,
        text: expect.any(String),
        deeplink: "https://peopl.paseo",
      },
      {
        kind: "missed",
        id: 2,
        scheduledAtMs: recordOf(EVENT_A).endTimeSeconds * 1_000,
        text: expect.any(String),
        deeplink: "https://peopl.paseo",
      },
    ]);

    await sweep();

    expect(harness.pushes).toHaveLength(2);
    expect(harness.registerCalls).toEqual([]);
  });

  it("cancels every pending push once the card is scratched", async () => {
    harness.standing = REGISTERED_AWAITING;
    await sweep();

    harness.standing = WON;
    harness.stored = applyScratched(stored(), EVENT_A, NOW);
    await sweep();

    // Both say "come and look", and the person has looked.
    expect(harness.cancels).toEqual([1, 2]);
    expect(recordOf(EVENT_A).notifications).toEqual([]);
  });

  describe("when the link pushes open has moved", () => {
    const OLD = "https://peopl.paseo/-/pocket/open?card=humanity";
    const NEW = "polkadotapp://pocket/open?product=peopl.paseo&card=humanity&open=scratch";

    it("books every pending push again under the new link, then cancels the old one", async () => {
      harness.standing = REGISTERED_AWAITING;
      harness.deps.deeplink = OLD;
      await sweep();
      const booked = harness.pushes.map(({ text, scheduledAtMs }) => ({ text, scheduledAtMs }));

      harness.deps.deeplink = NEW;
      await sweep();

      // Same words at the same moments; only where the tap lands changed.
      const rebooked = harness.pushes.slice(2);
      expect(rebooked).toHaveLength(2);
      expect(rebooked).toEqual(
        expect.arrayContaining(booked.map((push) => ({ ...push, deeplink: NEW }))),
      );
      expect([...harness.cancels].sort()).toEqual([1, 2]);
      const notifications = recordOf(EVENT_A).notifications;
      expect(notifications).toHaveLength(2);
      for (const entry of notifications) {
        expect(entry.id).toBeGreaterThan(2);
        expect(entry.deeplink).toBe(NEW);
      }

      await sweep();

      expect(harness.pushes).toHaveLength(4);
      expect(harness.cancels).toHaveLength(2);
    });

    it("books a push recorded before links were kept again", async () => {
      harness.standing = REGISTERED_AWAITING;
      await sweep();
      const registry = stored();
      const record = recordOf(EVENT_A);
      harness.stored = {
        ...registry,
        draws: {
          ...registry.draws,
          [EVENT_A]: {
            ...record,
            notifications: record.notifications.map(unrecorded),
          },
        },
      };

      await sweep();

      expect([...harness.cancels].sort()).toEqual([1, 2]);
      expect(recordOf(EVENT_A).notifications.map((entry) => entry.deeplink)).toEqual([
        "https://peopl.paseo",
        "https://peopl.paseo",
      ]);
    });

    it("keeps the old push when its replacement cannot be booked", async () => {
      harness.standing = REGISTERED_AWAITING;
      harness.deps.deeplink = OLD;
      await sweep();

      harness.deps.deeplink = NEW;
      harness.pushError = new Error("ScheduleLimitReached");
      await sweep();

      // A person keeps a push that lands somewhere stale rather than losing it.
      expect(harness.cancels).toEqual([]);
      expect(recordOf(EVENT_A)).toMatchObject({
        notifications: [
          expect.objectContaining({ id: 1, deeplink: OLD }),
          expect.objectContaining({ id: 2, deeplink: OLD }),
        ],
        notificationError: "ScheduleLimitReached",
      });
    });
  });

  it("leaves a winner's pending reminder to fire with everyone else's", async () => {
    harness.standing = REGISTERED_AWAITING;
    await sweep();

    harness.standing = WON;
    await sweep();
    await sweep();

    expect(harness.cancels).toEqual([]);
    expect(harness.pushes).toHaveLength(2);
    expect(recordOf(EVENT_A).notifications.map((entry) => entry.kind)).toEqual([
      "claim-window",
      "missed",
    ]);
  });

  it("keeps a winner's pending reminder for a caller that says it in the app", async () => {
    harness.standing = REGISTERED_AWAITING;
    await sweep();

    // What the app's own sweep passes. Dropping the reminder here is what used
    // to let the worker read it as never placed and push late.
    harness.deps.won = false;
    harness.standing = WON;
    await sweep();

    expect(harness.cancels).toEqual([]);
    expect(harness.pushes).toHaveLength(2);
    expect(recordOf(EVENT_A).notifications.map((entry) => entry.kind)).toEqual([
      "claim-window",
      "missed",
    ]);
  });

  it("pushes nothing after the scratch when the app saw the win first", async () => {
    harness.standing = REGISTERED_AWAITING;
    await sweep();
    const placed = harness.pushes.length;

    // The field report: the app sees the win, the person scratches, and the
    // worker ticks next.
    harness.deps.won = false;
    harness.standing = WON;
    await sweep();
    harness.stored = applyScratched(stored(), EVENT_A, NOW);
    harness.deps.won = true;
    await sweep();

    expect(harness.pushes).toHaveLength(placed);
    expect(recordOf(EVENT_A).notifications).toEqual([]);
  });

  it("records a push failure and holds the retry until the backoff elapses", async () => {
    harness.standing = REGISTERED_AWAITING;
    harness.pushError = new Error("ScheduleLimitReached");

    await expect(sweep()).resolves.toMatchObject({ result: "ok" });

    expect(recordOf(EVENT_A)).toMatchObject({
      notifications: [],
      notificationError: "ScheduleLimitReached",
      notificationRetrySeconds: NOW + CONFIG.notificationRetrySeconds,
    });

    harness.pushError = null;
    const failedAttempts = harness.pushes.length;
    harness.nowSeconds = NOW + CONFIG.notificationRetrySeconds - 1;
    await sweep();
    expect(harness.pushes).toHaveLength(failedAttempts);

    harness.nowSeconds = NOW + CONFIG.notificationRetrySeconds;
    await sweep();

    expect(harness.pushes).toHaveLength(failedAttempts + 2);
    expect(recordOf(EVENT_A)).toMatchObject({
      notificationError: null,
      notificationRetrySeconds: null,
    });
  });

  it("keeps an app write that landed mid-sweep instead of overwriting it", async () => {
    harness.standing = REGISTERED_AWAITING;
    // The app registers a second draw from the UI while this sweep waits on
    // the host push, through the same shared record. A sweep that wrote back
    // the copy it read at the start would erase that `submitted` marker, and
    // the next pass would pay for a duplicate submission of EVENT_B.
    harness.onPush = () => {
      harness.stored = applyRegistrationSubmitted(
        harness.stored ?? emptyRegistry(ACCOUNT),
        [EVENT_B],
        "app",
        NOW,
      );
    };

    await expect(sweep()).resolves.toMatchObject({ result: "ok" });

    expect(recordOf(EVENT_B).registration).toMatchObject({
      state: "submitted",
      source: "app",
    });
    // ...and the sweep's own work is all there: the reconciled draw facts,
    // the reminder it scheduled, and the tick stamp.
    expect(recordOf(EVENT_A)).toMatchObject({
      drawIndex: "7",
      status: "DrawWinners",
      registration: { state: "registered" },
    });
    expect(recordOf(EVENT_A).notifications.map((entry) => entry.kind)).toEqual([
      "claim-window",
      "missed",
    ]);
    expect(stored().lastTick).toEqual({
      atSeconds: NOW,
      result: "ok",
      error: null,
    });
  });

  it("counts one attempt per submission, so the retry gate opens on schedule", async () => {
    // A draw whose registration window stays open across both passes.
    harness.standing = standingOf([
      participation({
        draw: draw({
          drawTimeSeconds: NOW + 100_000,
          endTimeSeconds: NOW + 200_000,
        }),
      }),
    ]);
    harness.registerResult = (eventIds) => [
      { eventIds, status: "failed", error: new Error("no signer") },
    ];

    await sweep();

    // `registerForDraws` counted this attempt in the store already. Replaying
    // the sweep's own copy of the result on top would count it twice and push
    // the gate out to the second backoff, silencing the retry below.
    expect(recordOf(EVENT_A).registration).toMatchObject({
      state: "failed",
      attempts: 1,
      nextAttemptSeconds: NOW + (CONFIG.registerRetryBackoffSeconds[0] ?? 0),
    });

    harness.nowSeconds = NOW + (CONFIG.registerRetryBackoffSeconds[0] ?? 0);
    await sweep();

    expect(harness.registerCalls).toEqual([[EVENT_A], [EVENT_A]]);
    expect(recordOf(EVENT_A).registration.attempts).toBe(2);
  });

  it("never asks for the notification handle when there is nothing to schedule", async () => {
    // On a phone, resolving the handle is a permission prompt: a pass that
    // only registers must not raise one.
    await sweep();

    expect(harness.resolverCalls).toBe(0);
    expect(harness.registerCalls).toEqual([[EVENT_A]]);
  });

  it("asks for the notification handle once, however many reminders it schedules", async () => {
    harness.standing = standingOf([
      participation({ registered: true, draw: draw({ status: "DrawWinners" }) }),
      participation({
        registered: true,
        slot: eventId(98),
        draw: draw({ eventId: EVENT_B, status: "DrawWinners" }),
      }),
    ]);

    await sweep();

    expect(harness.pushes).toHaveLength(4);
    expect(harness.resolverCalls).toBe(1);
  });

  it("skips the schedule but still forgets a handle the host cannot cancel", async () => {
    harness.host = null;
    harness.standing = REGISTERED_AWAITING;

    await sweep();

    expect(recordOf(EVENT_A).notifications).toEqual([]);

    // A reminder from an earlier pass, now stale, with no manager to cancel
    // it: the record is dropped anyway, or the planner would re-issue the
    // same cancel on every pass forever.
    harness.stored = {
      ...stored(),
      draws: {
        [EVENT_A]: {
          ...recordOf(EVENT_A),
          outcome: "miss",
          notifications: [
            {
              kind: "claim-window",
              id: 7,
              scheduledAtMs: (NOW + 60) * 1_000,
              text: "x",
            },
          ],
        },
      },
    };

    await sweep();

    expect(harness.cancels).toEqual([]);
    expect(recordOf(EVENT_A).notifications).toEqual([]);
  });

  it("reports an error and writes nothing when the registry cannot be read", async () => {
    harness.readError = new Error("storage unavailable");

    await expect(sweep()).resolves.toEqual({ result: "error", actions: [] });

    expect(harness.writes).toBe(0);
    expect(harness.stored).toBeNull();
    expect(harness.registerCalls).toEqual([]);
  });

  it("stamps a failing action on the tick record instead of throwing", async () => {
    harness.registerError = new Error("People Chain did not respond in time.");

    await expect(sweep()).resolves.toMatchObject({ result: "error" });

    expect(stored().lastTick).toEqual({
      atSeconds: NOW,
      result: "error",
      error: "People Chain did not respond in time.",
    });
  });
});
