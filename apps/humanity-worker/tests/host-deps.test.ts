// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as HumanityUserIdModule from "@humanity/shared/identity/humanity-user-id.ts";

import { createPocketCardDeps } from "../src/host-deps.ts";

const chain = vi.hoisted(() => ({
  read: null as null | (() => Promise<unknown>),
  args: [] as unknown[],
  consumerAtBest: null as null | (() => Promise<unknown>),
  consumerArgs: [] as unknown[],
}));

vi.mock("@humanity/shared/identity/humanity-user-id.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof HumanityUserIdModule>()),
  resolveHumanityUserId: () =>
    Promise.resolve({ primaryUsername: "erin.dot", username: "erin", isUpgraded: false }),
}));

vi.mock("@humanity/shared/airdrops/chain/airdrop-account.ts", () => ({
  resolveAirdropAccount: () => Promise.resolve({ address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" }),
}));

vi.mock("@humanity/shared/identity/game-account.ts", () => ({
  resolveGameAccountAddress: () => Promise.resolve("game-account"),
}));

vi.mock("@humanity/shared/card/read-humanity-card.ts", () => ({
  readHumanityCard: (args: unknown) => {
    chain.args.push(args);
    return chain.read!();
  },
}));

vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: () =>
    Promise.resolve({
      api: {
        query: {
          Resources: {
            Consumers: {
              getValue: (...args: unknown[]) => {
                chain.consumerArgs.push(args);
                return chain.consumerAtBest!();
              },
            },
          },
        },
      },
    }),
}));

const OWNER = "5Owner";

function card(state: object, { primaryUsername = "erin.dot", upgraded = false } = {}) {
  return {
    kind: "card",
    accountAddress: OWNER,
    primaryUsername,
    state,
    snapshot: { isUpgradedIdentity: upgraded },
  };
}

describe("pocket card face state", () => {
  beforeEach(() => {
    chain.read = null;
    chain.args = [];
    chain.consumerAtBest = () => Promise.resolve(undefined);
    chain.consumerArgs = [];
  });

  const resolveFace = () => createPocketCardDeps().resolveFace();

  it("draws a member as a member, with their weeks", async () => {
    chain.read = () => Promise.resolve(card({ kind: "member", activeWeeks: 7 }));
    await expect(resolveFace()).resolves.toEqual({
      face: { name: "erin.dot", state: { kind: "member", weeks: 7 } },
      floor: false,
    });
    expect(chain.args).toEqual([
      expect.objectContaining({ gameAccount: "game-account" }),
    ]);
  });

  it("draws a candidate with score and threshold", async () => {
    chain.read = () =>
      Promise.resolve(card({ kind: "candidate", score: 4, personhoodThreshold: 10 }));
    await expect(resolveFace()).resolves.toEqual({
      face: { name: "erin.dot", state: { kind: "candidate", score: 4, threshold: 10 } },
      floor: false,
    });
  });

  it("follows a claimed name the host has not caught up with", async () => {
    chain.read = () =>
      Promise.resolve(card({ kind: "member", activeWeeks: 7 }, { primaryUsername: "erin", upgraded: true }));
    await expect(resolveFace()).resolves.toEqual({
      face: { name: "erin", state: { kind: "member", weeks: 7 } },
      floor: false,
    });
    expect(chain.consumerArgs).toEqual([]);
  });

  it("draws a name claim as soon as it is in the best block, before finality", async () => {
    chain.read = () => Promise.resolve(card({ kind: "member", activeWeeks: 7 }));
    chain.consumerAtBest = () =>
      Promise.resolve({ full_username: new TextEncoder().encode("erinfull") });
    await expect(resolveFace()).resolves.toEqual({
      face: { name: "erinfull.dot", state: { kind: "member", weeks: 7 } },
      floor: false,
    });
    expect(chain.consumerArgs).toEqual([[OWNER, { at: "best" }]]);
  });

  it("keeps the finalized name when the best-block read fails", async () => {
    chain.read = () => Promise.resolve(card({ kind: "member", activeWeeks: 7 }));
    chain.consumerAtBest = () => Promise.reject(new Error("rpc down"));
    await expect(resolveFace()).resolves.toEqual({
      face: { name: "erin.dot", state: { kind: "member", weeks: 7 } },
      floor: false,
    });
  });

  it("draws devicehood as a floor when the read fails", async () => {
    chain.read = () => Promise.reject(new Error("rpc down"));
    await expect(resolveFace()).resolves.toEqual({
      face: { name: "erin", state: { kind: "devicehood" } },
      floor: true,
    });
  });

  it("falls back to devicehood when the account is unavailable", async () => {
    chain.read = () => Promise.resolve({ kind: "account-unavailable" });
    await expect(resolveFace()).resolves.toEqual({
      face: { name: "erin", state: { kind: "devicehood" } },
      floor: false,
    });
  });
});
