// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** One file a manifest names, with its content address on Bulletin. */
export interface ManifestAsset {
  cid?: string
  mime?: string
}

interface Manifest {
  assets?: { thumbnail?: ManifestAsset; baseImage?: ManifestAsset }
}

/**
 * The picture of an item, from the bytes of the manifest its metadata names.
 *
 * The thumbnail when there is one, else the base image, and null for bytes
 * that are not a manifest or name neither.
 */
export function manifestPicture(bytes: Uint8Array): ManifestAsset & { cid: string } | null {
  let manifest: Manifest | null
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest | null
  } catch {
    return null
  }
  const assets = manifest?.assets
  const asset = assets?.thumbnail?.cid ? assets.thumbnail : assets?.baseImage
  return asset?.cid ? { ...asset, cid: asset.cid } : null
}
