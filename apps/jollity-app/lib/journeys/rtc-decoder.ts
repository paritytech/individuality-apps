// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * DECODER CHANGES through the game (#556). Pure and framework-free, like
 * rtc-path.ts: it reads the inbound video each report of the mesh's getStats
 * loop already carries. `trackDecoders` returns the peers whose decoder
 * implementation or negotiated codec just changed on a link that had one
 * before (the first sight of a link is no change), once each. Android falls
 * back mid-game ("FFmpeg (fallback from: ExternalDecoder ...)"), and nothing
 * else marks when. A reading without a field keeps the last one, so a gap is
 * not a change. A rebuilt connection (a new `link`) starts afresh.
 */
import { UNSUPPORTED } from "../webrtc/gather"
import type { RtcSample } from "../webrtc/rtc-stats"

export interface DecoderChange {
  id: string
  /** the rtc.decoder_change step's attributes (all text) */
  attrs: Record<string, string>
}

interface Seen {
  link: number
  decoder?: string
  codec?: string
  fmtp?: string
}

const NO_CHANGES: DecoderChange[] = []
let known = new Map<string, Seen>()

export function resetDecoders(): void {
  known = new Map()
}

export function trackDecoders(readings: ReadonlyArray<{ id: string; quality?: RtcSample }>): DecoderChange[] {
  let changes = NO_CHANGES
  for (const { id, quality: q } of readings) {
    const inbound = q?.inbound
    if (!q || !inbound) continue
    const was = known.get(id)
    const now: Seen =
      was && was.link === q.link
        ? { link: q.link, decoder: inbound.decoderImplementation ?? was.decoder, codec: inbound.codec ?? was.codec, fmtp: inbound.codecFmtp ?? was.fmtp }
        : { link: q.link, decoder: inbound.decoderImplementation, codec: inbound.codec, fmtp: inbound.codecFmtp }
    known.set(id, now)
    if (!was || was.link !== q.link) continue
    const decoderChanged = was.decoder !== undefined && now.decoder !== undefined && was.decoder !== now.decoder
    const codecChanged = was.codec !== undefined && now.codec !== undefined && was.codec !== now.codec
    if (!decoderChanged && !codecChanged) continue
    if (changes === NO_CHANGES) changes = []
    changes.push({
      id,
      attrs: {
        "rtc.decoder_from": was.decoder ?? UNSUPPORTED,
        "rtc.decoder": now.decoder ?? UNSUPPORTED,
        "rtc.codec_from": was.codec ?? UNSUPPORTED,
        "rtc.codec": now.codec ?? UNSUPPORTED,
        "rtc.codec_fmtp": now.fmtp ?? UNSUPPORTED,
      },
    })
  }
  return changes
}
