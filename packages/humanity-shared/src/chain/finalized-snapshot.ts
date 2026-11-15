// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BlockInfo, PolkadotClient } from "polkadot-api";

import { tracedRead } from "./chain-read.ts";

/** The `at` options every read of one snapshot shares. */
export interface SnapshotAt {
  at: string;
  signal: AbortSignal;
}

/** `@polkadot-api/observable-client` error name; the class is not exported from `polkadot-api`. */
const BLOCK_NOT_PINNED = "BlockNotPinnedError";

/**
 * Runs `read` against one finalized block so its reads agree, re-opening the
 * snapshot on a fresh block when PAPI unpins it mid-read.
 *
 * PAPI unpins a finalized block as soon as a newer one finalizes and nothing
 * holds it, and the public client exposes no hold. `getFinalizedBlock()` thus
 * yields a hash good for one block interval; a multi-read snapshot over the
 * host bridge crosses that line routinely and fails with `BlockNotPinnedError`.
 * Other rejections propagate unchanged.
 */
export async function readAtFinalized<T>(
  client: Pick<PolkadotClient, "getFinalizedBlock">,
  signal: AbortSignal,
  read: (at: SnapshotAt, block: BlockInfo) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    const block = await tracedRead("finalized.pin", () => client.getFinalizedBlock());
    signal.throwIfAborted();
    try {
      return await read({ at: block.hash, signal }, block);
    } catch (error) {
      const lapsed = error instanceof Error && error.name === BLOCK_NOT_PINNED;
      if (attempt >= maxAttempts || signal.aborted || !lapsed) {
        throw error;
      }
    }
  }
}
