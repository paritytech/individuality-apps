// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { toGamePhaseView } from "@humanity/shared/chain/game-phase.ts";

// Real timestamps decoded from live game 135 on Paseo People Next.
const REGISTRATION_ENDS = 1785585300;
const SHUFFLE_DEADLINE = 1785585510;
const REPORT_ENDS = 1785585960;

const BEFORE = 1785585000;

describe("toGamePhaseView", () => {
  it("names Registration and counts down to registration_ends", () => {
    expect(
      toGamePhaseView("Registration", REGISTRATION_ENDS, BEFORE),
    ).toEqual({
      label: "registration",
      nextDeadlineSeconds: REGISTRATION_ENDS,
      secondsRemaining: 300,
    });
  });

  it("names Shuffle and counts down to shuffle_deadline", () => {
    expect(toGamePhaseView("Shuffle", SHUFFLE_DEADLINE, BEFORE)).toEqual({
      label: "shuffle",
      nextDeadlineSeconds: SHUFFLE_DEADLINE,
      secondsRemaining: 510,
    });
  });

  it("names Reporting and counts down to report_ends", () => {
    expect(toGamePhaseView("Reporting", REPORT_ENDS, BEFORE)).toEqual({
      label: "reporting",
      nextDeadlineSeconds: REPORT_ENDS,
      secondsRemaining: 960,
    });
  });

  it("gives PlayerProcess no deadline", () => {
    expect(toGamePhaseView("PlayerProcess", null, BEFORE)).toEqual({
      label: "processing",
      nextDeadlineSeconds: null,
      secondsRemaining: null,
    });
  });

  it("gives Cancelling no deadline", () => {
    expect(toGamePhaseView("Cancelling", null, BEFORE)).toEqual({
      label: "cancelling",
      nextDeadlineSeconds: null,
      secondsRemaining: null,
    });
  });

  it("clamps a deadline already past at zero", () => {
    expect(
      toGamePhaseView("Registration", REGISTRATION_ENDS, REGISTRATION_ENDS + 60)
        .secondsRemaining,
    ).toBe(0);
  });
});
