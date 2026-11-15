// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { membershipRingLocation } from "@humanity/shared/chain/individuality.ts";
const m = vi.hoisted(() => ({
  provider: vi.fn(),
  client: vi.fn(),
  resolve: vi.fn(),
  list: vi.fn(),
  member: vi.fn(),
}));
vi.mock("@humanity/shared/chain/host-api.ts", async (original) => ({
  ...(await original<typeof import("@humanity/shared/chain/host-api.ts")>()),
  getAccountsProvider: m.provider,
}));
vi.mock("@humanity/shared/chain/client.ts", () => ({ getPeopleClient: m.client }));
vi.mock("@humanity/shared/chain/ring-vrf-key.ts", () => ({
  resolveRingVrfKeyHandle: m.resolve,
}));
import { readFullPersonhood } from "@humanity/shared/chain/full-personhood.ts";
const network = resolveNetwork("previewnet");
const ring = membershipRingLocation(network);
const publicKey = new Uint8Array(32).fill(7);
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.resetAllMocks();
  m.provider.mockResolvedValue({ listRingVrfKeys: m.list });
  m.resolve.mockResolvedValue({ handle: {}, ring });
  m.list.mockReturnValue({
    match: async (ok: (v: unknown) => unknown) =>
      ok([{ handle: {}, rings: [ring], publicKey }]),
  });
  m.client.mockResolvedValue({
    client: { getFinalizedBlock: async () => ({ hash: "0xfinal" }) },
    api: { query: { Members: { Members: { getValue: m.member } } } },
  });
});

describe("full-personhood eligibility", () => {
  it.each(["Onboarding", "Suspended", undefined])(
    "does not treat %s as full ring membership",
    async (type) => {
      m.member.mockResolvedValue(type == null ? undefined : { type });
      expect(await readFullPersonhood(network, "peopl.testnet", signal())).toBe(
        false,
      );
    },
  );
  it("accepts Included membership independently of game score", async () => {
    m.member.mockResolvedValue({ type: "Included" });
    expect(await readFullPersonhood(network, "peopl.testnet", signal())).toBe(
      true,
    );
    expect(m.list).toHaveBeenCalledWith("peopl.testnet", "PublicKey");
    expect(m.member).toHaveBeenCalledWith(
      ring.junctions[0]!.value,
      `0x${"07".repeat(32)}`,
      expect.objectContaining({ at: "0xfinal" }),
    );
  });
  it("does not guess eligibility when public-key disclosure is refused", async () => {
    m.list.mockReturnValue({
      match: async (ok: (v: unknown) => unknown) =>
        ok([{ handle: {}, rings: [ring] }]),
    });
    await expect(
      readFullPersonhood(network, "peopl.testnet", signal()),
    ).rejects.toThrow("disclose");
    expect(m.member).not.toHaveBeenCalled();
  });
  it("stops after cancellation without reading chain membership", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readFullPersonhood(network, "peopl.testnet", controller.signal),
    ).rejects.toThrow();
    expect(m.member).not.toHaveBeenCalled();
  });
});
