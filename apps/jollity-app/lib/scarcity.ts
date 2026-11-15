// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The chest of the app, read through `@jollity/collectables`.
 *
 * The read itself is shared with the chat worker. The app shows the verified
 * art of `loadManifestArt` and logs to its debug sheet.
 */
import {
  readChest as readSharedChest,
  readChestPinned as readSharedChestPinned,
  type ChestView,
  type ReadChestOptions as SharedReadChestOptions,
  type ScarcityChain,
} from "@jollity/collectables"
import { loadManifestArt } from "./collectable-art"
import { devLog } from "./debug/log-store"

export {
  ChestReadError,
  type ChestChoice,
  type ChestItem,
  type ChestView,
} from "@jollity/collectables"

export type ReadChestOptions = Omit<SharedReadChestOptions, "loadArt" | "log">

const appArt: Pick<SharedReadChestOptions, "loadArt" | "log"> = {
  loadArt: (manifestCid) => loadManifestArt(manifestCid),
  log: (message, context) => devLog("chest", message, context, "warn"),
}

export function readChest(
  chain: ScarcityChain,
  account: string,
  gameIndex: number | null,
  options: ReadChestOptions = {},
): Promise<Omit<ChestView, "seed">> {
  return readSharedChest(chain, account, gameIndex, { ...appArt, ...options })
}

export function readChestPinned(
  chain: ScarcityChain,
  account: string,
  gameIndex: number | null,
  options: ReadChestOptions = {},
  attempts?: number,
): Promise<Omit<ChestView, "seed">> {
  return readSharedChestPinned(chain, account, gameIndex, { ...appArt, ...options }, attempts)
}
