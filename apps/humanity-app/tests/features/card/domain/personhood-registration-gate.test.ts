// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  registrationGate,
  stopBackoffMs,
  type RegistrationGateInput,
} from "@features/card/domain/personhood-registration.ts";

const ready = { kind: "membership-ready", activeWeeks: 1, lastAttendedGame: 4, attendanceHistory: 1, window: 8 } as const;
const base: RegistrationGateInput = {
  live: true,
  card: { kind: "card", owner: "5Owner", state: ready, playAccount: "5Play" },
  busy: false,
  pausedUntil: 0,
  record: null,
  now: 10_000_000,
};

describe("registrationGate", () => {
  it("names every reason not to fire, in order", () => {
    expect(registrationGate({ ...base, live: false }).kind).toBe("not-live");
    expect(registrationGate({ ...base, card: undefined }).kind).toBe("no-card");
    expect(registrationGate({ ...base, card: { kind: "account-unavailable" } }).kind).toBe("no-card");
    expect(registrationGate({ ...base, busy: true }).kind).toBe("in-flight");
    expect(registrationGate({ ...base, pausedUntil: base.now + 1 }).kind).toBe("paused");
    expect(registrationGate({ ...base, pausedUntil: Number.POSITIVE_INFINITY }).detail).toContain(
      "paused for this launch",
    );
    expect(registrationGate(base)).toEqual({
      kind: "firing",
      detail: "card is membership-ready; owner 5Owner, card plays as 5Play",
    });
  });

  it("says when a held registration may try again", () => {
    const record = {
      status: "stopped" as const,
      candidate: "5C",
      at: base.now,
      kind: "refused" as const,
      attempts: 2,
    };
    const gate = registrationGate({ ...base, record });
    expect(gate.kind).toBe("holding");
    expect(gate.detail).toContain("stopped (refused, 2x)");
    expect(gate.detail).toContain(new Date(base.now + stopBackoffMs(2)).toISOString());
  });
});
