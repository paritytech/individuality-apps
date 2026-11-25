// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The collectables screen of the app, read through `@jollity/collectables`.
 *
 * The read itself is shared with the chat worker. The app shows the verified
 * art of `loadManifestArt` and logs to its debug sheet.
 */
import {
  readCollectables as readSharedCollectables,
  readCollectablesPinned as readSharedCollectablesPinned,
  type CollectablesView,
  type ReadCollectablesOptions as SharedReadCollectablesOptions,
  type ScarcityChain,
} from "@jollity/collectables"
import { loadManifestArt } from "./collectable-art"
import { devLog } from "./debug/log-store"

export {
  CollectablesReadError,
  type CollectablesChoice,
  type CollectablesItem,
  type CollectablesView,
} from "@jollity/collectables"

export type ReadCollectablesOptions = Omit<SharedReadCollectablesOptions, "loadArt" | "log">

const appArt: Pick<SharedReadCollectablesOptions, "loadArt" | "log"> = {
  loadArt: (manifestCid) => loadManifestArt(manifestCid),
  log: (message, context) => devLog("chest", message, context, "warn"),
}

export function readCollectables(
  chain: ScarcityChain,
  account: string,
  gameIndex: number | null,
  options: ReadCollectablesOptions = {},
): Promise<Omit<CollectablesView, "seed">> {
  return readSharedCollectables(chain, account, gameIndex, { ...appArt, ...options })
}

export function readCollectablesPinned(
  chain: ScarcityChain,
  account: string,
  gameIndex: number | null,
  options: ReadCollectablesOptions = {},
  attempts?: number,
): Promise<Omit<CollectablesView, "seed">> {
  return readSharedCollectablesPinned(chain, account, gameIndex, { ...appArt, ...options }, attempts)
}
