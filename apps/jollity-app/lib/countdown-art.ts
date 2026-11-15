// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The last-minute countdown art is MODULAR and swappable WEEKLY (Doodle-style —
 * the art changes without an app redeploy). The registry of art modules lives
 * in components/countdown/registry.tsx; this file is the weekly SELECTOR: it
 * fetches a small JSON manifest and says which module (or one-off image) to show.
 *
 * Manifest (all fields optional):
 *   { "module": "dial" }         → a registered component module
 *   { "svg": "<svg …>" }         → a one-off inline doodle (sandboxed <img>)
 *   { "cid": "0x…" }             → a one-off Bulletin image (preimage/gateway)
 *   { "accent": "#f59e0b" }      → colour for the numeric readout
 * Absent / unreachable manifest → null → the default module (the dial).
 *
 * TODO(chain-pointer): replace the fetch with a statement-store pointer under a
 * fixed topic (LWW per publisher channel) whose payload is this same manifest —
 * all primitives exist in statement-core.
 */
import { loadVerifiedImage } from "./collectable-art"

const ART_URL = process.env.NEXT_PUBLIC_COUNTDOWN_ART_URL ?? "/countdown-art.json"

interface CountdownArtManifest {
  /** name a registered module (components/countdown/registry.tsx) */
  module?: string
  /** a one-off inline SVG doodle */
  svg?: string
  /** a one-off Bulletin CID */
  cid?: string
  /** accent for the countdown numerals (CSS color) */
  accent?: string
}

/** What the manifest resolved to. `null` = use the default module (the dial). */
export interface CountdownArtChoice {
  module?: string
  imageUrl?: string
  accent?: string
}

export async function fetchCountdownArt(): Promise<CountdownArtChoice | null> {
  try {
    const response = await fetch(ART_URL, { cache: "no-store" })
    if (!response.ok) return null
    const manifest = (await response.json()) as CountdownArtManifest
    if (manifest.module) return { module: manifest.module, accent: manifest.accent }
    if (manifest.svg) {
      const imageUrl = URL.createObjectURL(new Blob([manifest.svg], { type: "image/svg+xml" }))
      return { imageUrl, accent: manifest.accent }
    }
    if (manifest.cid) {
      const imageUrl = await loadVerifiedImage(manifest.cid)
      return imageUrl ? { imageUrl, accent: manifest.accent } : null
    }
    return null
  } catch {
    return null // no manifest → the default module (the dial)
  }
}
