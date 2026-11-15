// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The cleanup reads the queue, the duration and the chain's clock, removes
 *  each expired entry ahead of the person with its own unsigned authorized
 *  transaction through the product account, in queue order, and stops at the
 *  first one that does not settle — never touching the person's own entry. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as HostApi from "@humanity/shared/chain/host-api.ts";
import type * as TransactionSubmission from "@humanity/shared/chain/transaction-submission.ts";

const mocks = vi.hoisted(() => ({
  queue: vi.fn(),
  duration: vi.fn(),
  now: vi.fn(),
  remove: vi.fn(),
  finalized: vi.fn(),
  getAccountsProvider: vi.fn(),
  getProductAccountSigner: vi.fn(),
  withAuthorizeCall: vi.fn(),
  watch: vi.fn(),
}));

vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: () =>
    Promise.resolve({
      client: { getFinalizedBlock: mocks.finalized },
      api: {
        query: {
          Resources: {
            UsernameReservationQueue: { getValue: mocks.queue },
            UsernameReservationDuration: { getValue: mocks.duration },
          },
          Timestamp: { Now: { getValue: mocks.now } },
        },
        tx: { Resources: { remove_expired_username_reservation: mocks.remove } },
      },
    }),
}));
vi.mock("@humanity/shared/chain/host-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof HostApi>()),
  getAccountsProvider: mocks.getAccountsProvider,
}));
vi.mock("@humanity/shared/chain/authorize-call-signer.ts", () => ({
  withAuthorizeCall: mocks.withAuthorizeCall,
}));
vi.mock("@humanity/shared/chain/transaction-submission.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof TransactionSubmission>()),
  watchTransactionSubmission: mocks.watch,
}));
const log = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@humanity/shared/logging/logger.ts", () => ({ loggerFor: () => log }));

import { clearExpiredReservations } from "@features/card/chain/clear-expired-reservations.ts";

const ME = "5Me";
const PRODUCT_ACCOUNT = { publicKey: new Uint8Array(32).fill(3), dotNsIdentifier: "peopl", derivationIndex: 0 };
const HOST_SIGNER = { kind: "host-signer" };
const AUTHORIZED_SIGNER = { kind: "authorized-signer" };

beforeEach(() => {
  vi.clearAllMocks();
  // Chain clock 3 000 000 s, duration 0: every entry has stood past 30 days.
  mocks.now.mockResolvedValue(3_000_000_000n);
  mocks.duration.mockResolvedValue(0n);
  mocks.queue.mockResolvedValue([
    { account: "5First", joined_at: 10n },
    { account: "5Second", joined_at: 20n },
    { account: ME, joined_at: 30n },
    { account: "5Behind", joined_at: 40n },
  ]);
  mocks.remove.mockImplementation((args: { account: string }) => ({ removes: args.account }));
  mocks.finalized.mockResolvedValue({ hash: "0xfin", number: 100 });
  mocks.getAccountsProvider.mockResolvedValue({
    getProductAccount: () => ({ match: async (ok: (value: unknown) => unknown) => ok(PRODUCT_ACCOUNT) }),
    getProductAccountSigner: mocks.getProductAccountSigner.mockReturnValue(HOST_SIGNER),
  });
  mocks.withAuthorizeCall.mockReturnValue(AUTHORIZED_SIGNER);
  mocks.watch.mockImplementation(async (tx: { removes: string }) => ({ status: "included", txHash: `0x${tx.removes}` }));
});

describe("clearExpiredReservations", () => {
  it("removes each expired entry ahead of the person, in queue order, as an authorized call", async () => {
    await expect(clearExpiredReservations("carol", ME)).resolves.toEqual({ status: "cleared", removed: 2 });

    expect(mocks.remove.mock.calls.map(([args]) => args.account)).toEqual(["5First", "5Second"]);
    expect(new TextDecoder().decode(mocks.remove.mock.calls[0]![0].username)).toBe("carol");
    expect(mocks.getProductAccountSigner).toHaveBeenCalledWith(PRODUCT_ACCOUNT);
    expect(mocks.withAuthorizeCall).toHaveBeenCalledWith(HOST_SIGNER);
    for (const [, signer, options] of mocks.watch.mock.calls) {
      expect(signer).toBe(AUTHORIZED_SIGNER);
      expect(options).toMatchObject({ at: "0xfin", mortality: { mortal: true, period: 64 } });
    }
  });

  it("compares against the chain's clock in seconds, like the runtime", async () => {
    // A People duration just over 30 days, read 1 s after 5First (joined at
    // 10 s) lapsed: 5Second (joined at 20 s) still holds.
    mocks.duration.mockResolvedValue(2_592_100n);
    mocks.now.mockResolvedValue(2_592_111_000n);

    await expect(clearExpiredReservations("carol", ME)).resolves.toEqual({ status: "cleared", removed: 1 });
    expect(mocks.remove.mock.calls.map(([args]) => args.account)).toEqual(["5First"]);
  });

  it("submits nothing and asks the host for nothing when nothing ahead has expired", async () => {
    mocks.now.mockResolvedValue(1_000_000n);

    await expect(clearExpiredReservations("carol", ME)).resolves.toEqual({ status: "nothing" });
    expect(mocks.getAccountsProvider).not.toHaveBeenCalled();
    expect(mocks.watch).not.toHaveBeenCalled();
  });

  it("submits nothing for a person not in the queue", async () => {
    await expect(clearExpiredReservations("carol", "5Stranger")).resolves.toEqual({ status: "nothing" });
    expect(mocks.watch).not.toHaveBeenCalled();
  });

  it("stops at the first removal that fails and reports how many went before it", async () => {
    mocks.watch
      .mockResolvedValueOnce({ status: "included", txHash: "0x1" })
      .mockRejectedValueOnce(new Error("Invalid transaction"));

    const outcome = await clearExpiredReservations("carol", ME);

    expect(outcome).toMatchObject({ status: "failed", removed: 1 });
    expect(mocks.watch).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("stops at a removal it could not confirm", async () => {
    mocks.watch.mockResolvedValueOnce({ status: "unknown", txHash: "0xmaybe", detail: "no inclusion" });

    await expect(clearExpiredReservations("carol", ME)).resolves.toMatchObject({ status: "failed", removed: 0 });
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    // Logged at error: the only path by which an unconfirmed removal files an issue.
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("fails without submitting outside a host", async () => {
    mocks.getAccountsProvider.mockResolvedValue(null);

    await expect(clearExpiredReservations("carol", ME)).resolves.toMatchObject({ status: "failed", removed: 0 });
    expect(mocks.watch).not.toHaveBeenCalled();
  });
});
