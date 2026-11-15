// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * CODEC IMPLEMENTATION CHANGES, BOTH DIRECTIONS (the codec map). Pure and
 * framework-free, like rtc-decoder.ts, which keeps the inbound
 * rtc.decoder_change step (#556) as it was. This one watches the decoder AND
 * the encoder, their hardware/software kind and the codec each direction
 * runs, and gives the trace one change per link and direction the moment one
 * of them moves: the trace counts it as `rtc.impl_change` (tracemetrics) and
 * puts an outbound one on the game journey as rtc.encoder_change.
 *
 * The values are FAMILIES (`implFamily`): Android names a fallback
 * "FFmpeg (fallback from: ExternalDecoder (MediaCodecVideoDecoder))", and the
 * map groups by what runs, FFmpeg. `implKind` says hardware or software:
 * Chrome's powerEfficient flag when there is one, else the name. A reading
 * without a field keeps the last one, so a gap is not a change, and a rebuilt
 * connection (a new `link`) starts afresh.
 */
import patterns from "./codec-impl-patterns.json"
import { UNSUPPORTED } from "../webrtc/gather"
import type { RtcSample } from "../webrtc/rtc-stats"

export type ImplKind = "hardware" | "software" | typeof UNSUPPORTED

/** the implementation in use: the name before any "(fallback from: …)" or "(…)" detail */
export function implFamily(name: string | undefined): string | undefined {
  const family = name?.split("(")[0]?.trim()
  return family || undefined
}

// hardware/software name rules: codec-impl-patterns.json (see its _note)
const HARDWARE = new RegExp(patterns.hardware, "i")
const SOFTWARE = new RegExp(patterns.software, "i")

/** hardware or software: the browser's power-efficient flag first, else the family's name */
export function implKind(name: string | undefined, efficient?: boolean): ImplKind {
  if (efficient !== undefined) return efficient ? "hardware" : "software"
  const family = implFamily(name)
  if (!family) return UNSUPPORTED
  if (SOFTWARE.test(family)) return "software"
  if (HARDWARE.test(family)) return "hardware"
  return UNSUPPORTED
}

export interface ImplChange {
  id: string
  /** rtc.direction in|out, rtc.impl_from / rtc.impl (families), their kinds,
   *  rtc.codec_from / rtc.codec, rtc.codec_fmtp: all text */
  attrs: Record<string, string>
}

interface Side {
  impl?: string
  kind: ImplKind
  codec?: string
  fmtp?: string
}

interface Seen {
  link: number
  in?: Side
  out?: Side
}

let known = new Map<string, Seen>()

export function resetImplChanges(): void {
  known = new Map()
}

/** one direction's reading folded over the last one */
function fold(was: Side | undefined, impl: string | undefined, efficient: boolean | undefined, codec: string | undefined, fmtp: string | undefined): Side {
  const family = implFamily(impl) ?? was?.impl
  const kind = efficient !== undefined || impl !== undefined ? implKind(impl ?? was?.impl, efficient) : (was?.kind ?? UNSUPPORTED)
  return { impl: family, kind, codec: codec ?? was?.codec, fmtp: fmtp ?? was?.fmtp }
}

/** a change worth saying: a known value that became a different known value */
const moved = (from: string | undefined, to: string | undefined) => from !== undefined && to !== undefined && from !== to

function change(id: string, direction: "in" | "out", was: Side | undefined, now: Side): ImplChange | null {
  if (!was) return null
  const kindMoved = was.kind !== UNSUPPORTED && now.kind !== UNSUPPORTED && was.kind !== now.kind
  if (!moved(was.impl, now.impl) && !kindMoved && !moved(was.codec, now.codec)) return null
  return {
    id,
    attrs: {
      "rtc.direction": direction,
      "rtc.impl_from": was.impl ?? UNSUPPORTED,
      "rtc.impl": now.impl ?? UNSUPPORTED,
      "rtc.impl_kind_from": was.kind,
      "rtc.impl_kind": now.kind,
      "rtc.codec_from": was.codec ?? UNSUPPORTED,
      "rtc.codec": now.codec ?? UNSUPPORTED,
      "rtc.codec_fmtp": now.fmtp ?? UNSUPPORTED,
    },
  }
}

/** The links whose decoder, encoder, kind or codec just changed, per direction, once each. */
export function trackImplChanges(readings: ReadonlyArray<{ id: string; quality?: RtcSample }>): ImplChange[] {
  const changes: ImplChange[] = []
  for (const { id, quality: q } of readings) {
    if (!q || (!q.inbound && !q.outbound)) continue
    const was = known.get(id)
    const same = was && was.link === q.link ? was : undefined
    const now: Seen = { link: q.link, in: same?.in, out: same?.out }
    if (q.inbound) now.in = fold(same?.in, q.inbound.decoderImplementation, q.inbound.powerEfficientDecoder, q.inbound.codec, q.inbound.codecFmtp)
    if (q.outbound) now.out = fold(same?.out, q.outbound.encoderImplementation, q.outbound.powerEfficientEncoder, q.outbound.codec, q.outbound.codecFmtp)
    known.set(id, now)
    if (!same) continue
    for (const found of [q.inbound ? change(id, "in", same.in, now.in!) : null, q.outbound ? change(id, "out", same.out, now.out!) : null]) if (found) changes.push(found)
  }
  return changes
}
