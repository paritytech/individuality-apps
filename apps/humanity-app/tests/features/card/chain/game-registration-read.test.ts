// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { GAME_REGISTRATION_KEY, REGISTERING_TTL_MS } from "@individuality/shared-records";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTruApi: vi.fn(),
  read: vi.fn(),
  own: { readJSON: vi.fn(), writeJSON: vi.fn() },
  getHostLocalStorage: vi.fn(),
}));

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  asProductId: (value: string) => value,
  getTruApi: mocks.getTruApi,
  getHostLocalStorage: mocks.getHostLocalStorage,
}));
vi.mock("@humanity/shared/identity/game-account.ts", () => ({ GAME_STORAGE_PRODUCT_DOMAIN: "dim2.testnet" }));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ info: vi.fn(), debug: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

import { ownGameRegistration, readGameRegistration } from "@features/card/chain/game-registration-read.ts";

const NOW = 1_800_000_000_000;

/** The hex a host answers a storage read with, as Jollity's `writeJSON` stores it. */
function stored(value: unknown): `0x${string}` {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const ok = (value: string | undefined) => ({ isOk: () => true, value: { value } });
const refused = (tag: string) => ({
  isOk: () => false,
  error: { tag: "Domain", value: { value: { tag } } },
});

describe("readGameRegistration", () => {
  beforeEach(() => {
    mocks.read.mockReset();
    mocks.own.readJSON.mockReset().mockResolvedValue(null);
    mocks.own.writeJSON.mockReset();
    mocks.getTruApi.mockResolvedValue({ localStorage: { read: mocks.read } });
    mocks.getHostLocalStorage.mockResolvedValue(mocks.own);
  });

  it("reads Jollity's record from Jollity's storage, whichever surface wrote it", async () => {
    const fromChat = { gameIndex: 1304, phase: "sent", surface: "chat", at: NOW - 500, attempt: 7 };
    mocks.read.mockResolvedValueOnce(ok(stored(fromChat)));
    await expect(readGameRegistration(NOW)).resolves.toEqual(fromChat);
    expect(mocks.read).toHaveBeenCalledWith({ product: "dim2.testnet", key: GAME_REGISTRATION_KEY });

    const fromApp = { gameIndex: 1304, phase: "failed", surface: "app", at: NOW - 500, attempt: 8, reason: "refused" };
    mocks.read.mockResolvedValueOnce(ok(stored(fromApp)));
    await expect(readGameRegistration(NOW)).resolves.toEqual(fromApp);
  });

  it("answers null for no record, a cleared one, a stale one and the old chat-only record", async () => {
    mocks.read.mockResolvedValueOnce(ok(undefined));
    await expect(readGameRegistration(NOW)).resolves.toBeNull();
    mocks.read.mockResolvedValueOnce(ok(stored(null)));
    await expect(readGameRegistration(NOW)).resolves.toBeNull();
    mocks.read.mockResolvedValueOnce(
      ok(stored({ gameIndex: 1, phase: "registering", surface: "chat", at: NOW - REGISTERING_TTL_MS - 1, attempt: 1 })),
    );
    await expect(readGameRegistration(NOW)).resolves.toBeNull();
    mocks.read.mockResolvedValueOnce(ok(stored({ gameIndex: 1, phase: "busy", at: NOW })));
    await expect(readGameRegistration(NOW)).resolves.toBeNull();
  });

  it("answers null, never throws, when the grant is missing or the host is absent or broken", async () => {
    mocks.read.mockResolvedValueOnce(refused("AccessNotGranted"));
    await expect(readGameRegistration(NOW)).resolves.toBeNull();
    mocks.read.mockResolvedValueOnce(ok("0x7b6e6f"));
    await expect(readGameRegistration(NOW)).resolves.toBeNull();
    mocks.read.mockRejectedValueOnce(new Error("bridge closed"));
    await expect(readGameRegistration(NOW)).resolves.toBeNull();
    mocks.getTruApi.mockResolvedValueOnce(null);
    await expect(readGameRegistration(NOW)).resolves.toBeNull();
  });

  it("keeps this home's own record when it is newer than Jollity's", async () => {
    const fromJollity = { gameIndex: 1304, phase: "failed", surface: "app", at: NOW - 900, attempt: 7, reason: "refused" };
    const own = { gameIndex: 1304, phase: "registering", surface: "humanity", at: NOW - 100, attempt: 9 };
    mocks.read.mockResolvedValueOnce(ok(stored(fromJollity)));
    mocks.own.readJSON.mockResolvedValueOnce(own);
    await expect(readGameRegistration(NOW)).resolves.toEqual(own);
    expect(mocks.own.readJSON).toHaveBeenCalledWith(GAME_REGISTRATION_KEY);
  });

  it("keeps one store's record when the other refuses or fails", async () => {
    const own = { gameIndex: 1304, phase: "sent", surface: "humanity", at: NOW - 100, attempt: 9 };
    mocks.read.mockResolvedValueOnce(refused("AccessNotGranted"));
    mocks.own.readJSON.mockResolvedValueOnce(own);
    await expect(readGameRegistration(NOW)).resolves.toEqual(own);

    const fromChat = { gameIndex: 1304, phase: "sent", surface: "chat", at: NOW - 500, attempt: 7 };
    mocks.read.mockResolvedValueOnce(ok(stored(fromChat)));
    mocks.own.readJSON.mockRejectedValueOnce(new Error("no storage"));
    await expect(readGameRegistration(NOW)).resolves.toEqual(fromChat);
  });

  it("writes this home's record to its own storage only", async () => {
    const own = { gameIndex: 1304, phase: "registering", surface: "humanity", at: NOW, attempt: 9 } as const;
    await ownGameRegistration.write(own);
    expect(mocks.own.writeJSON).toHaveBeenCalledWith(GAME_REGISTRATION_KEY, own);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
