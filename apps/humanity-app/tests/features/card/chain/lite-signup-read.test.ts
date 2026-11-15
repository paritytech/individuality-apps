// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NetworkConfig } from "@humanity/shared/chain/networks.ts";

const mocks = vi.hoisted(() => ({
  fromPapi: vi.fn(),
  readLiteSignUpRequirement: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@humanity/shared/chain/individuality.ts", () => ({
  fromPapi: mocks.fromPapi,
  readLiteSignUpRequirement: mocks.readLiteSignUpRequirement,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ error: mocks.error, info: mocks.info, debug: mocks.debug }),
}));

import { readLiteSignUpVerdict } from "@features/card/chain/lite-signup-read.ts";

const seatAccount = "5DIM2Seat";
const network = { dotnsSuffix: "seat.test" } as NetworkConfig;
const api = { query: {} } as never;
const client = { getFinalizedBlock: vi.fn() } as never;
const signal = new AbortController().signal;

/** The SDK's `Result` is a plain discriminated union, not a neverthrow value —
 *  a mock carrying `match` would pass while the real one narrows on `ok`. */
function resultAsync<T>(value: T | Error) {
  return value instanceof Error
    ? { ok: false as const, error: value }
    : { ok: true as const, value };
}

function readVerdict() {
  return readLiteSignUpVerdict({ api, client, network, seatAccount, signal });
}

/** A recognizable non-zero key. A default-constructed `Uint8Array(32)` deep-
 *  equals every other zeroed one, so the forwarding assertion would pass even
 *  if the wrong array reached the SDK. */
const DEVICEHOOD_KEY = new Uint8Array(32).fill(0x8c);

/** Both the pre-read gate line and the verdict line are `info`; only the
 *  verdict line carries the membership outcome. */
function verdictLogFields(): Record<string, unknown> {
  const call = mocks.info.mock.calls.find((args) =>
    String(args[0]).startsWith("seat verdict"),
  );
  if (call == null) throw new Error("seat verdict was not logged");
  return call[1];
}

/** The gate line's interpolated text — the only part a debug snapshot keeps. */
function membershipGateText(): string {
  const call = mocks.info.mock.calls.find((args) =>
    String(args[0]).includes("membership gate"),
  );
  if (call == null) throw new Error("membership gate was not logged");
  return String(call[1].membershipGate);
}

/** The options the SDK read was actually called with. Which properties are
 *  present is the assertion, so this must not be an optional-chained view:
 *  `toEqual` treats an explicit `undefined` as an absent property. */
function requirementOptions(): { liteMemberKey?: Uint8Array } {
  const call = mocks.readLiteSignUpRequirement.mock.calls[0];
  if (call == null) throw new Error("the requirement read was not called");
  return call[1];
}

beforeEach(() => {
  mocks.fromPapi.mockReset();
  mocks.readLiteSignUpRequirement.mockReset();
  mocks.error.mockReset();
  mocks.info.mockReset();
  mocks.debug.mockReset();
  mocks.fromPapi.mockReturnValue({ individuality: api });
});

describe("readLiteSignUpVerdict", () => {
  it("keeps a clean chain verdict sign-up eligible and passes the network suffix", async () => {
    mocks.readLiteSignUpRequirement.mockResolvedValue(
      resultAsync({ canSignUp: true, blockers: [] }),
    );

    await expect(readVerdict()).resolves.toEqual({
      canSignUp: true,
      needsBind: false,
      blockers: [],
      invitedAccount: null,
    });
    expect(mocks.readLiteSignUpRequirement).toHaveBeenCalledWith(
      expect.anything(),
      { account: seatAccount, tld: network.dotnsSuffix, signal },
    );
    expect(mocks.fromPapi).toHaveBeenCalledWith(client, api);
  });

  it("omits the membership option entirely when no lite member key is held", async () => {
    mocks.readLiteSignUpRequirement.mockResolvedValue(
      resultAsync({ canSignUp: false, blockers: [{ tag: "AliasNotBound" }] }),
    );

    await readVerdict();

    // An empty `Uint8Array` would read as a key in no ring at all. The option
    // must be absent, so the SDK skips the check it documents as ours.
    expect(Object.hasOwn(requirementOptions(), "liteMemberKey")).toBe(false);
    expect(membershipGateText()).toContain("no lite member key in state");
    expect(verdictLogFields().membership).toBe("unchecked");
  });

  it("says membership was verified when a forwarded key clears the ring", async () => {
    // Identical blockers to the omitted-key case above: without the membership
    // field a reader cannot tell a passed gate from one that never ran.
    mocks.readLiteSignUpRequirement.mockResolvedValue(
      resultAsync({ canSignUp: false, blockers: [{ tag: "AliasNotBound" }] }),
    );

    await readLiteSignUpVerdict({
      api,
      client,
      network,
      seatAccount,
      liteMemberKey: DEVICEHOOD_KEY,
      signal,
    });

    expect(membershipGateText()).toContain("lite member key forwarded");
    expect(verdictLogFields().membership).toBe("included");
  });

  it("forwards an available Devicehood key so the membership gate can answer", async () => {
    mocks.readLiteSignUpRequirement.mockResolvedValue(
      resultAsync({ canSignUp: false, blockers: [{ tag: "NotLiteMember" }] }),
    );

    await expect(
      readLiteSignUpVerdict({
        api,
        client,
        network,
        seatAccount,
        liteMemberKey: DEVICEHOOD_KEY,
        signal,
      }),
    ).resolves.toMatchObject({
      blockers: [{ tag: "NotLiteMember" }],
      // A non-member is not one bind away from a seat, so the bind the app can
      // run must not be offered — the host would refuse the proof anyway.
      needsBind: false,
    });
    expect(mocks.readLiteSignUpRequirement).toHaveBeenCalledWith(
      expect.anything(),
      {
        account: seatAccount,
        tld: network.dotnsSuffix,
        liteMemberKey: DEVICEHOOD_KEY,
        signal,
      },
    );
    expect(verdictLogFields().membership).toBe("not-a-member");
  });

  it("offers a bind only when AliasNotBound is the sole blocker", async () => {
    mocks.readLiteSignUpRequirement.mockResolvedValue(
      resultAsync({ canSignUp: false, blockers: [{ tag: "AliasNotBound" }] }),
    );

    await expect(readVerdict()).resolves.toMatchObject({ needsBind: true });
  });

  it("does not offer a bind when the pinned invite belongs to another seat", async () => {
    mocks.readLiteSignUpRequirement.mockResolvedValue(
      resultAsync({
        canSignUp: false,
        blockers: [
          { tag: "AliasNotBound" },
          { tag: "AnotherAccountInvited", invited: "5PinnedSeat" },
        ],
      }),
    );

    await expect(readVerdict()).resolves.toMatchObject({
      needsBind: false,
      invitedAccount: "5PinnedSeat",
    });
  });

  it("returns unknown when the SDK reports an error result", async () => {
    mocks.readLiteSignUpRequirement.mockResolvedValue(
      resultAsync(new Error("People Chain unavailable")),
    );

    await expect(readVerdict()).resolves.toBeNull();
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("keeps a read cancelled mid-flight out of the error log", async () => {
    // A foreground refresh cancels the query in flight; the SDK then answers
    // with the abort as an error result.
    const controller = new AbortController();
    mocks.readLiteSignUpRequirement.mockImplementation(async () => {
      controller.abort();
      return resultAsync(new Error("signal is aborted without reason"));
    });

    await expect(
      readLiteSignUpVerdict({ api, client, network, seatAccount, signal: controller.signal }),
    ).resolves.toBeNull();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.debug).toHaveBeenCalledOnce();
  });

  it("keeps a cancelled read that throws out of the error log", async () => {
    const controller = new AbortController();
    mocks.readLiteSignUpRequirement.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("signal is aborted without reason", "AbortError");
    });

    await expect(
      readLiteSignUpVerdict({ api, client, network, seatAccount, signal: controller.signal }),
    ).resolves.toBeNull();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("still reports a read that throws while its signal is live", async () => {
    mocks.readLiteSignUpRequirement.mockRejectedValue(new Error("host transport closed"));

    await expect(readVerdict()).resolves.toBeNull();
    expect(mocks.error).toHaveBeenCalledOnce();
  });
});
