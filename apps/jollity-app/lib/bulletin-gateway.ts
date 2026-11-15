// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Bulletin IPFS gateway, with no dependencies.
 *
 * It lives apart from lib/collectable-art.ts so that a screen which only needs
 * a URL for a CID does not pull in the hashing and telemetry of the verified
 * artwork read.
 */
export const IPFS_GATEWAY = "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs"

/** Gives the gateway URL for a CID at once, for previews and dev screens. */
export function gatewayImageUrl(cid: string): string {
  return `${IPFS_GATEWAY}/${cid}`
}
