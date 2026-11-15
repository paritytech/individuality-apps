// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import { readAtFinalized } from "@humanity/shared/chain/finalized-snapshot.ts";

function notPinned(hash: string): Error {
  const error = new Error(`Block ${hash} is not pinned (storage)`);
  error.name = "BlockNotPinnedError";
  return error;
}

function clientWithHeads(...hashes: string[]) {
  let index = 0;
  return {
    getFinalizedBlock: vi.fn(() => {
      const hash = hashes[Math.min(index, hashes.length - 1)]!;
      index += 1;
      return Promise.resolve({
        hash,
        number: index,
        parent: "0x00",
        hasNewRuntime: false,
      });
    }),
  };
}

describe("readAtFinalized", () => {
  it("hands every read the same finalized hash", async () => {
    const client = clientWithHeads("0xaa");
    const signal = new AbortController().signal;
    const result = await readAtFinalized(client, signal, (at) =>
      Promise.resolve([at.at, at.signal === signal]),
    );
    expect(result).toEqual(["0xaa", true]);
    expect(client.getFinalizedBlock).toHaveBeenCalledTimes(1);
  });

  it("re-pins a fresh block when the previous pin lapsed mid-read", async () => {
    const client = clientWithHeads("0xaa", "0xbb");
    const seen: string[] = [];
    const result = await readAtFinalized(
      client,
      new AbortController().signal,
      (at) => {
        seen.push(at.at);
        return at.at === "0xaa"
          ? Promise.reject(notPinned(at.at))
          : Promise.resolve("value");
      },
    );
    expect(result).toBe("value");
    expect(seen).toEqual(["0xaa", "0xbb"]);
  });

  it("gives up after the last attempt with the pin error itself", async () => {
    const client = clientWithHeads("0xaa");
    const error = notPinned("0xaa");
    await expect(
      readAtFinalized(
        client,
        new AbortController().signal,
        () => Promise.reject(error),
        2,
      ),
    ).rejects.toBe(error);
    expect(client.getFinalizedBlock).toHaveBeenCalledTimes(2);
  });

  it("propagates any other rejection without retrying", async () => {
    const client = clientWithHeads("0xaa", "0xbb");
    const error = new Error("People Chain did not respond in time.");
    await expect(
      readAtFinalized(client, new AbortController().signal, () =>
        Promise.reject(error),
      ),
    ).rejects.toBe(error);
    expect(client.getFinalizedBlock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the read was aborted", async () => {
    const controller = new AbortController();
    const client = clientWithHeads("0xaa", "0xbb");
    await expect(
      readAtFinalized(client, controller.signal, (at) => {
        controller.abort();
        return Promise.reject(notPinned(at.at));
      }),
    ).rejects.toThrow("not pinned");
    expect(client.getFinalizedBlock).toHaveBeenCalledTimes(1);
  });
});
