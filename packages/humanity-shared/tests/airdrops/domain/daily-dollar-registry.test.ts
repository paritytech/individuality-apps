// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  DAILY_DOLLAR_REGISTRY_VERSION,
  type AirdropDraw,
  type AirdropParticipation,
  type AirdropStanding,
  type DailyDollarRegistry,
  type DrawRecord,
  type Hex32,
} from "@individuality/daily-dollar";
import {
  DEFAULT_REGISTRY_PLAN_CONFIG,
  applyNotificationCancelled,
  applyRegistrationResult,
  applyRegistrationSubmitted,
  applyScratched,
  emptyRegistry,
  planRegistrations,
  reconcileRegistry,
  sanitizeRegistry,
} from "@humanity/shared/airdrops/domain/daily-dollar-registry.ts";

const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CONFIG = DEFAULT_REGISTRY_PLAN_CONFIG;
const NOW = 1_000_000;

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

  it("defaults the scratch stamp for a record written before the app set it", () => {
    const stored = serialized(registryOf([record()])) as {
      draws: Record<string, Record<string, unknown>>;
    };
    delete stored.draws[EVENT_A]?.["scratchedAtSeconds"];

    const parsed = sanitizeRegistry(stored, ACCOUNT);

    // Rejecting the record would forget a registration and pay to make it
    // again, so the missing field defaults instead.
    expect(parsed.draws[EVENT_A]).toEqual(record());
  });

  it("ignores the chat dedupe list older records carry", () => {
    const stored = serialized(registryOf([record()])) as {
      draws: Record<string, Record<string, unknown>>;
    };
    stored.draws[EVENT_A] = {
      ...stored.draws[EVENT_A],
      announced: ["result"],
      scratchedAtSeconds: "soon",
    };

    const parsed = sanitizeRegistry(stored, ACCOUNT);

    expect(parsed.draws[EVENT_A]).toEqual(record());
  });

  it("drops Jollity's link and chat fields and stores the rest in a fixed order", () => {
    const stored = serialized(registryOf([record()])) as {
      draws: Record<string, Record<string, unknown>>;
    };
    // Keys written in the opposite order, so the stored order is the parser's.
    stored.draws[EVENT_A] = Object.fromEntries(
      Object.entries({
        ...stored.draws[EVENT_A],
        notifications: [
          {
            kind: "claim-window",
            id: 4,
            scheduledAtMs: 5_000,
            text: "hi",
            deeplink: "https://peopl.paseo/-/pocket/open?card=humanity",
          },
        ],
        announced: ["result"],
      }).reverse(),
    );

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
      "updatedAtSeconds",
    ]);
    expect(JSON.stringify(parsed)).toBe(
      JSON.stringify(
        record({
          notifications: [{ kind: "claim-window", id: 4, scheduledAtMs: 5_000, text: "hi" }],
        }),
      ),
    );
  });

  it("keeps a well-formed tick and drops a malformed one", () => {
    const withTick: DailyDollarRegistry = {
      ...registryOf([]),
      lastTick: { atSeconds: NOW, result: "ok", error: null },
    };
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

  it("carries the scratch stamp through a refreshed draw", () => {
    // A reconcile that rebuilt the record from the standing alone would drop
    // the scratch stamp, and the planner would remind about an opened card.
    const registry = registryOf([
      record({
        status: "Claiming",
        outcome: "won",
        scratchedAtSeconds: NOW - 10,
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
    expect(delays).toEqual([0, 1, 2].map((i) => CONFIG.registerRetryBackoffSeconds[Math.min(i, CONFIG.registerRetryBackoffSeconds.length - 1)]));
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

  it("keeps an undetermined submission busy while an attempt could still be live, then retries it", () => {
    const registry = applyRegistrationResult(
      applyRegistrationSubmitted(emptyRegistry(ACCOUNT), [EVENT_A], "worker", NOW),
      [EVENT_A],
      { status: "unknown", error: "timed out" },
      "worker",
      NOW,
      CONFIG,
    );

    expect(registry.draws[EVENT_A]?.registration.state).toBe("unknown");
    const still = standingOf([participation()]);
    expect(planRegistrations(registry, still, NOW + CONFIG.stuckRegistrationSeconds - 1, CONFIG)).toEqual([]);
    expect(planRegistrations(registry, still, NOW + CONFIG.stuckRegistrationSeconds, CONFIG)).toEqual([EVENT_A]);
  });
});

describe("applyNotificationCancelled", () => {
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

});

describe("applyScratched", () => {
  it("stamps the first reveal and leaves a later one alone", () => {
    const scratched = applyScratched(registryOf([record()]), EVENT_A, NOW);
    expect(scratched.draws[EVENT_A]?.scratchedAtSeconds).toBe(NOW);
    expect(scratched.draws[EVENT_A]?.updatedAtSeconds).toBe(NOW);

    // A remount re-fires the reveal callback; re-stamping would move the
    // moment that counts for a card opened once.
    const again = applyScratched(scratched, EVENT_A, NOW + 500);
    expect(again.draws[EVENT_A]?.scratchedAtSeconds).toBe(NOW);
  });

  it("ignores a reveal for a draw it has no record of", () => {
    const registry = registryOf([record()]);

    expect(applyScratched(registry, EVENT_B, NOW).draws).toEqual(registry.draws);
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
