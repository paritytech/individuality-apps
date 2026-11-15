// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHO SEES WHOM: each phone's view of its room, one character per member in
 * the room's sorted order, sent to every peer so that each one can check its
 * own links against what the others see. A group of four where the faces come
 * and go is then caught, and named, while the game is on: a phone that a peer
 * says it cannot see heals its side (mesh.ts watchMedia), and a pair that can
 * reach a third phone but not each other is logged as a relay candidate.
 *
 *   -  this phone itself, its camera on
 *   ~  this phone itself, its camera off: how a peer knows "Camera off"
 *   0  never heard (no hello, no signal)
 *   1  heard on the statement store, no link
 *   2  linked, but no video decoding
 *   3  video decoding on the current link
 *
 * The row rides twice: on the hello the statement store re-sends every 8 s, or
 * every 16 s once every link is up (statementTransport `setView`,
 * STABLE_HELLO_MS), which arrives while the link is DOWN, the case
 * that matters most, and as a frame on every open data channel every 4 s, which
 * the store's delay does not touch. Both carry the same string,
 * `<tag>:<codes>`: the tag is a short hash of the member list, so a phone whose
 * roster differs reads nothing rather than the wrong seat.
 *
 * Display and healing only, never a vote: the row is unauthenticated on the
 * store (anyone can write a hello under any `from`, #324).
 *
 * The frame is OURS, as the away frame is: a peer that does not know the
 * use-case id drops it. Decoding never throws.
 */
import { decodeChannelMessage, encodeChannelMessage } from "@jollity/statement-core"

/** The envelope id the frame rides under. Wire, not a name we may pick freely once a peer reads it. */
export const USE_CASE_LINK_VIEW = "jollity_link_view_use_case"

export type ViewCode = "-" | "~" | "0" | "1" | "2" | "3"
export const VIEW = { self: "-", selfCameraOff: "~", unheard: "0", heard: "1", linked: "2", video: "3" } as const satisfies Record<string, ViewCode>

const CODES = new Set<string>(["-", "~", "0", "1", "2", "3"])

/** A short hash of the room's members (FNV-1a over the sorted ids): two phones with one roster read each other's rows. */
export function roomTag(members: readonly string[]): string {
  let hash = 0x811c9dc5
  for (const ch of [...members].sort().join(",")) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0").slice(0, 4)
}

/** This phone's row: the code for each member, in sorted order, behind the room's tag. */
export function encodeView(members: readonly string[], codeOf: (member: string) => ViewCode): string {
  const sorted = [...members].sort()
  return `${roomTag(sorted)}:${sorted.map(codeOf).join("")}`
}

/** A peer's row as member → code, or null when it is not a row of this room (another roster, a bad length, a stray character). */
export function decodeView(row: string, members: readonly string[]): Map<string, ViewCode> | null {
  const sorted = [...members].sort()
  const [tag, codes, ...rest] = row.split(":")
  if (rest.length || tag !== roomTag(sorted) || codes === undefined || codes.length !== sorted.length) return null
  const out = new Map<string, ViewCode>()
  for (const [i, member] of sorted.entries()) {
    const code = codes[i]!
    if (!CODES.has(code)) return null
    out.set(member, code as ViewCode)
  }
  return out
}

/** The row as a data-channel frame. */
export function encodeViewFrame(row: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encodeChannelMessage({ id: USE_CASE_LINK_VIEW, data: new TextEncoder().encode(row) }))
}

/** A data-channel frame's row, or null for anything that is not a view frame. Never throws. */
export function decodeViewFrame(bytes: Uint8Array): string | null {
  try {
    const frame = decodeChannelMessage(bytes)
    if (frame.id !== USE_CASE_LINK_VIEW) return null
    return new TextDecoder().decode(frame.data)
  } catch {
    return null
  }
}
