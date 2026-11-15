// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { signUpWords } from "@features/card/domain/sign-up-words.ts";

describe("signUpWords", () => {
  it("offers Register when nothing is under way", () => {
    expect(signUpWords("idle")).toEqual({ registering: false, label: null, note: null });
  });

  it("says the seat is getting ready while the bind and the name link land", () => {
    expect(signUpWords("waiting-seat")).toEqual({
      registering: true,
      label: "Getting your seat ready…",
      note: null,
    });
  });

  it("holds Register while the sign-up is sent", () => {
    for (const phase of ["sending", "chat", "reminders"] as const) {
      expect(signUpWords(phase)).toEqual({ registering: true, label: null, note: null });
    }
  });

  it("keeps holding, with a line, while a slow or cut-off sign-up is retried", () => {
    expect(signUpWords("slow")).toMatchObject({ registering: true, note: expect.stringContaining("longer than usual") });
    expect(signUpWords("host-chain")).toMatchObject({ registering: true, note: expect.stringContaining("Polkadot app") });
    expect(signUpWords("network")).toMatchObject({ registering: true, note: expect.stringContaining("network") });
    expect(signUpWords("name-unowned")).toMatchObject({ registering: true, note: expect.stringContaining("isn't registered") });
  });

  it("lets go of Register with the reason once the sign-up has ended", () => {
    expect(signUpWords("closed")).toEqual({
      registering: false,
      label: null,
      note: "Registration has closed for this game.",
    });
    expect(signUpWords("refused")).toEqual({
      registering: false,
      label: null,
      note: "We couldn't register you for this game.",
    });
  });
});
