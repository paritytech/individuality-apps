// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Loads collectable and countdown art, verified against its address.
 *
 * On the Bulletin chain the blake2b-256 digest of an image is its preimage key,
 * so inside a host container the bytes come through the product-sdk preimage
 * manager and need no network permission. A plain browser reads the Bulletin
 * IPFS gateway instead. Either way `getVerifiedArtwork` checks the bytes before
 * anything renders them.
 */

import { blake2b } from "@noble/hashes/blake2.js"
import { sha256 } from "@noble/hashes/sha2.js"
import type { ArtworkAddress, ArtworkSource } from "@parity/product-sdk-nfts"
import { AsyncCache } from "./async-cache"
import { devLog } from "./debug/log-store"
import { describeError } from "./host/error-detail"
import { reportFailure } from "./telemetry"
import { IPFS_GATEWAY } from "./bulletin-gateway"
import { manifestPicture } from "@jollity/collectables"

const PREIMAGE_TIMEOUT_MS = 10_000
const HOST_HEAD_START_MS = 1_500

const BLAKE2B_256 = 0xb220
const SHA2_256 = 0x12

/**
 * Checks host bytes against their address before they can win the race.
 *
 * Bytes that fail here would make `getVerifiedArtwork` answer Mismatch with the
 * gateway never asked, so they count as the host not having the image. The
 * two multihashes the SDK verifies are checked, blake2b-256 and sha2-256, and
 * any other passes through to the full check.
 */
export function matchesAddress(bytes: Uint8Array, address: ArtworkAddress): boolean {
  const digest =
    address.multihash === BLAKE2B_256
      ? blake2b(bytes, { dkLen: 32 })
      : address.multihash === SHA2_256
        ? sha256(bytes)
        : null
  if (!digest) return true
  const hex = `0x${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`
  return hex === address.digest.toLowerCase()
}

/**
 * Resolves to the first source that has the bytes, giving the host a head start.
 *
 * A host without a preimage never answers null: the SDK source settles only on
 * its timeout, and the truapi-host CLI holds no Bulletin preimage at all. So
 * the gateway starts after a short head start instead of after the timeout.
 * Its bytes are verified against the same digest, so it costs no trust.
 */
export function firstBytes(
  host: Promise<Uint8Array | null>,
  fallback: () => Promise<Uint8Array | null>,
  headStartMs = HOST_HEAD_START_MS,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  // an unmounted caller aborts its reads: that is not a failure worth a line per item
  const warn = (message: string, error: unknown) => {
    if (signal?.aborted || (error as { name?: unknown } | null)?.name === "AbortError") return
    devLog("art", message, { detail: describeError(error) }, "warn")
  }
  return new Promise((resolve) => {
    let pending = 2
    let started = false
    const settle = (bytes: Uint8Array | null) => {
      if (bytes) return resolve(bytes)
      if (--pending === 0) resolve(null)
    }
    const startFallback = () => {
      if (started) return
      started = true
      fallback().then(settle, (error: unknown) => {
        warn("gateway read failed", error)
        settle(null)
      })
    }
    const timer = setTimeout(startFallback, headStartMs)
    host.then(
      (bytes) => {
        if (bytes) clearTimeout(timer)
        else startFallback()
        settle(bytes)
      },
      (error: unknown) => {
        warn("host preimage read failed", error)
        startFallback()
        settle(null)
      },
    )
  })
}

/**
 * Picks where verified artwork bytes come from.
 *
 * The host preimage manager serves them inside a container, with the Bulletin
 * gateway behind it for anything the host does not hold. Outside a container
 * the gateway serves alone.
 */
async function artworkSource(): Promise<ArtworkSource> {
  const nfts = await import("@parity/product-sdk-nfts")
  try {
    const sdk = await import("@parity/product-sdk-host")
    if (sdk.isInsideContainerSync()) {
      const manager = await sdk.getPreimageManager()
      if (manager) {
        const preimage = nfts.preimageSource(manager, PREIMAGE_TIMEOUT_MS)
        const gateway = nfts.gatewaySource(IPFS_GATEWAY)
        return (address, signal) =>
          firstBytes(
            preimage(address, signal).then((bytes) => (bytes && matchesAddress(bytes, address) ? bytes : null)),
            () => gateway(address, signal),
            undefined,
            signal,
          )
      }
    }
  } catch {
    /* the host SDK throws outside a container, where the gateway serves */
  }
  return nfts.gatewaySource(IPFS_GATEWAY)
}

/** a manifest's verified art as a blob URL; "" (a failed load) is not kept, so a
 *  gateway that recovers gets asked again */
const verified = new AsyncCache<string>({ keep: (url) => url !== "" })

/** hashes already reported this page load: a failed load is retried, and
 *  each retry must not be another event */
const reportedArt = new Set<string>()

function artFailed(cid: string, reason: "read-failed" | "not-verified", detail: string): void {
  if (reportedArt.has(cid)) return
  reportedArt.add(cid)
  reportFailure("art-failed", { reason, context: { hash: cid, detail } })
}

/** Accepts a base32 CIDv1 or a `0x` blake2b-256 digest, the Bulletin preimage key. */
async function verifiedBytes(cid: string): Promise<Uint8Array | null> {
  const nfts = await import("@parity/product-sdk-nfts")
  const image = cid.startsWith("0x") ? { hex: cid, text: null } : { hex: "", text: cid }
  const result = await nfts.getVerifiedArtwork(image, { source: await artworkSource() })
  if (!result.ok) {
    devLog("art", "artwork read failed", { cid, detail: result.error.message }, "warn")
    artFailed(cid, "read-failed", result.error.message)
    return null
  }
  if (result.value.tag !== "Verified") {
    devLog("art", "artwork not verified", { cid, tag: result.value.tag }, "warn")
    artFailed(cid, "not-verified", result.value.tag)
    return null
  }
  return result.value.bytes
}

/**
 * Loads the art of an item from the manifest its metadata names.
 *
 * Both the manifest and the image it points at are verified against their
 * CIDs, so an image a gateway swapped never renders. It resolves to an empty
 * string when either read fails, and the collectables screen draws its placeholder for that.
 */
export function loadManifestArt(manifestCid: string): Promise<string> {
  return verified.ensure(manifestCid, async () => {
    const bytes = await verifiedBytes(manifestCid)
    if (!bytes) return ""
    const asset = manifestPicture(bytes)
    if (!asset) {
      devLog("art", "manifest names no picture", { cid: manifestCid }, "warn")
      return ""
    }
    const image = await verifiedBytes(asset.cid)
    return image
      ? URL.createObjectURL(new Blob([image as BlobPart], { type: asset.mime ?? "image/webp" }))
      : ""
  })
}

/**
 * Loads one image and verifies it against its address before it renders.
 *
 * It resolves to an empty string when the bytes are missing or do not match.
 */
export async function loadVerifiedImage(cid: string): Promise<string> {
  if (!cid) return ""
  const bytes = await verifiedBytes(cid)
  return bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/webp" })) : ""
}
